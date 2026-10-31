import { spawn } from 'node:child_process';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './files.js';
import { atomicJson, readJson, type Acceptance } from './state.js';

export const PROCESS_LOG_LIMIT = 10 * 1024 * 1024;
export const BROKER_STALE_MS = 5000;
export interface ProcessScope {
  statePath: string;
  deviceId: string;
  projectId: string;
  root: string;
}
export interface ProcessRecord {
  scope: ProcessScope;
  sessionId: string;
  startJobId: string;
  digest: string;
  command: string;
  timeoutMs: number;
  createdAt: string;
}
export interface ProcessSession {
  sessionId: string;
  status: 'starting' | 'running' | 'exited' | 'stopped' | 'timed_out' | 'failed' | 'uncertain';
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdinClosed: boolean;
  outputBytes: number;
  truncated: boolean;
  error?: string;
}
export interface BrokerStatus extends ProcessSession {
  heartbeat: string;
}
export interface ProcessRequest {
  jobId: string;
  digest: string;
  scope: ProcessScope;
  operation:
    { kind: 'process.input'; input: string; closeStdin: boolean } | { kind: 'process.stop' };
}
export interface ProcessReply {
  state: 'done' | 'failed' | 'uncertain';
  result?: unknown;
  error?: string;
}
export class ProcessUncertainError extends Error {}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function syncDirectory(dir: string) {
  const h = await open(dir, 'r');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
export const processScopeDir = (scope: ProcessScope) =>
  path.join(scope.statePath, 'processes', hash(JSON.stringify(scope)));
export const processSessionDir = (scope: ProcessScope, sessionId: string) => {
  if (!/^ps_[a-f0-9]{64}$/.test(sessionId)) throw Error('Invalid process session ID');
  return path.join(processScopeDir(scope), sessionId);
};
export const sameScope = (a: ProcessScope, b: ProcessScope) =>
  a.statePath === b.statePath &&
  a.deviceId === b.deviceId &&
  a.projectId === b.projectId &&
  a.root === b.root;

export async function processSession(dir: string, record: ProcessRecord): Promise<ProcessSession> {
  const stored = await readJson<BrokerStatus>(path.join(dir, 'status.json')).catch(() => null);
  const status: ProcessSession = stored
    ? { ...stored }
    : {
        sessionId: record.sessionId,
        status: 'starting',
        createdAt: record.createdAt,
        finishedAt: null,
        exitCode: null,
        stdinClosed: false,
        outputBytes: 0,
        truncated: false,
      };
  delete (status as Partial<BrokerStatus>).heartbeat;
  if (
    (status.status === 'running' || status.status === 'starting') &&
    Date.now() - Date.parse(stored?.heartbeat ?? record.createdAt) > BROKER_STALE_MS
  ) {
    status.status = 'uncertain';
    status.error =
      'Process broker evidence is stale. Work and stdin will not be replayed; inspect this device locally.';
  }
  return status;
}

async function scopedRecord(scope: ProcessScope, sessionId: string) {
  const dir = processSessionDir(scope, sessionId);
  const record = await readJson<ProcessRecord>(path.join(dir, 'session.json')).catch(() => null);
  if (!record || record.sessionId !== sessionId || !sameScope(record.scope, scope))
    throw Error('Process session not found in this project and device');
  return { dir, record };
}

async function sessions(scope: ProcessScope) {
  const names = await readdir(processScopeDir(scope)).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[];
    throw e;
  });
  const result: ProcessSession[] = [];
  for (const name of names
    .filter((name) => /^ps_[a-f0-9]{64}$/.test(name))
    .sort()
    .slice(0, 500)) {
    const dir = processSessionDir(scope, name);
    const record = await readJson<ProcessRecord>(path.join(dir, 'session.json')).catch(() => null);
    if (!record) {
      result.push({
        sessionId: name,
        status: 'uncertain',
        createdAt: (await stat(dir)).birthtime.toISOString(),
        finishedAt: null,
        exitCode: null,
        stdinClosed: true,
        outputBytes: 0,
        truncated: false,
        error: 'Incomplete process acceptance; work will not be replayed',
      });
    } else if (record.sessionId === name && sameScope(record.scope, scope)) {
      result.push(await processSession(dir, record));
    }
  }
  return { sessions: result, truncated: names.length > 500 };
}

async function start(scope: ProcessScope, accepted: Acceptance) {
  const op = accepted.dispatch.job.operation;
  if (op.kind !== 'process.start') throw Error('Invalid start operation');
  const sessionId = `ps_${hash(accepted.dispatch.job.id)}`;
  const dir = processSessionDir(scope, sessionId);
  const record: ProcessRecord = {
    scope,
    sessionId,
    startJobId: accepted.dispatch.job.id,
    digest: accepted.digest,
    command: op.command,
    timeoutMs: op.timeoutMs,
    createdAt: new Date().toISOString(),
  };
  await mkdir(processScopeDir(scope), { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(processScopeDir(scope)));
  await syncDirectory(scope.statePath);
  const previous = await sessions(scope);
  // The ordinary project job lock serializes starts, while sessions remain independent.
  if (
    !previous.sessions.some((s) => s.sessionId === sessionId) &&
    (previous.truncated ||
      previous.sessions.length >= 500 ||
      previous.sessions.filter((s) => ['running', 'starting', 'uncertain'].includes(s.status))
        .length >= 16)
  )
    throw Error(
      'This project has 16 active/uncertain process sessions or 500 retained sessions; inspect and archive locally before adding more',
    );
  let created = false;
  try {
    // The permanent session directory and broker claim are never removed/reclaimed.
    // A crash at any point is evidence of uncertainty, not permission to spawn again.
    await mkdir(dir, { mode: 0o700 });
    await syncDirectory(processScopeDir(scope));
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (created) {
    await atomicJson(path.join(dir, 'session.json'), record);
    await mkdir(path.join(dir, 'requests'), { mode: 0o700 });
    await syncDirectory(dir);
    const source = import.meta.url.endsWith('.ts');
    const broker = fileURLToPath(
      new URL(source ? './process-broker.ts' : './process-broker.js', import.meta.url),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      source ? ['--import', 'tsx', broker, dir] : [broker, dir],
      {
        detached: true,
        stdio: 'ignore',
        env,
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } else {
    const saved = await readJson<ProcessRecord>(path.join(dir, 'session.json')).catch(() => null);
    if (!saved)
      throw new ProcessUncertainError('Incomplete process acceptance; refusing to restart it');
    if (
      !sameScope(saved.scope, scope) ||
      saved.digest !== record.digest ||
      saved.startJobId !== record.startJobId
    )
      throw Error('Process start payload digest mismatch');
    Object.assign(record, saved);
  }
  for (let i = 0; i < 120; i++) {
    const session = await processSession(dir, record);
    if (session.status === 'uncertain') throw new ProcessUncertainError(session.error);
    if (session.status !== 'starting') return session;
    await pause(50);
  }
  throw new ProcessUncertainError('Process start has no confirmed result; it will not be replayed');
}

async function request(scope: ProcessScope, accepted: Acceptance, sessionId: string) {
  const { dir, record } = await scopedRecord(scope, sessionId);
  const operation = accepted.dispatch.job.operation;
  if (operation.kind !== 'process.input' && operation.kind !== 'process.stop')
    throw Error('Invalid process request');
  if (operation.kind === 'process.input' && Buffer.byteLength(operation.input) > 65_536)
    throw Error('Process input exceeds 65536 UTF-8 bytes');
  const reqDir = path.join(dir, 'requests', hash(accepted.dispatch.job.id));
  const body: ProcessRequest = {
    jobId: accepted.dispatch.job.id,
    digest: accepted.digest,
    scope,
    operation:
      operation.kind === 'process.stop'
        ? { kind: 'process.stop' }
        : {
            kind: 'process.input',
            input: operation.input,
            closeStdin: operation.closeStdin,
          },
  };
  let existing = false;
  try {
    await mkdir(reqDir, { mode: 0o700 });
    await syncDirectory(path.dirname(reqDir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    existing = true;
  }
  if (existing) {
    const saved = await readJson<ProcessRequest>(path.join(reqDir, 'request.json')).catch(
      () => null,
    );
    if (!saved)
      throw new ProcessUncertainError('Incomplete stdin/stop request; refusing to replay');
    if (
      saved.digest !== body.digest ||
      saved.jobId !== body.jobId ||
      !sameScope(saved.scope, scope)
    )
      throw Error('Process request payload digest mismatch');
  } else {
    await atomicJson(path.join(reqDir, 'request.json'), body);
    const current = await processSession(dir, record);
    if (current.status === 'uncertain') {
      await atomicJson(path.join(reqDir, 'reply.json'), {
        state: 'uncertain',
        error: current.error,
      });
      throw new ProcessUncertainError(current.error);
    }
    if (current.status !== 'running') {
      if (operation.kind === 'process.stop') {
        await atomicJson(path.join(reqDir, 'reply.json'), { state: 'done', result: current });
        return current;
      }
      const error = `Process session is ${current.status}; stdin is unavailable`;
      await atomicJson(path.join(reqDir, 'reply.json'), { state: 'failed', error });
      throw Error(error);
    }
  }
  for (let i = 0; i < 160; i++) {
    const reply = await readJson<ProcessReply>(path.join(reqDir, 'reply.json')).catch(() => null);
    if (reply?.state === 'done') return reply.result;
    if (reply?.state === 'failed') throw Error(reply.error ?? 'Process request failed');
    if (reply?.state === 'uncertain') throw new ProcessUncertainError(reply.error);
    if ((await processSession(dir, record)).status === 'uncertain')
      throw new ProcessUncertainError(
        'Process broker lost while applying request; stdin/stop will not be replayed',
      );
    await pause(50);
  }
  throw new ProcessUncertainError(
    'Process request was accepted but its outcome is unknown; do not resend input with a new key',
  );
}

export async function executeProcessOperation(
  jobDir: string,
  accepted: Acceptance,
  root: string,
): Promise<unknown> {
  if (!accepted.config.allowShell)
    throw Error(
      'Process sessions require locally enabled --allow-shell, including read and list controls',
    );
  const { job, project } = accepted.dispatch;
  if (job.deviceId !== project.deviceId || job.projectId !== project.id)
    throw Error('Process project/device mismatch');
  const scope: ProcessScope = {
    statePath: await realpath(path.resolve(jobDir, '../..')),
    deviceId: job.deviceId,
    projectId: project.id,
    root,
  };
  const op = job.operation;
  if (op.kind === 'process.start') return start(scope, accepted);
  if (op.kind === 'process.list') return sessions(scope);
  if (op.kind === 'process.input' || op.kind === 'process.stop')
    return request(scope, accepted, op.sessionId);
  if (op.kind === 'process.output') {
    const { dir, record } = await scopedRecord(scope, op.sessionId);
    const h = await open(path.join(dir, 'output.log'), 'r').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    let data = Buffer.alloc(0),
      size = 0;
    if (h)
      try {
        size = Math.min((await h.stat()).size, PROCESS_LOG_LIMIT);
        const offset = Math.min(op.offset, size);
        data = Buffer.alloc(Math.min(op.limit, size - offset));
        const read = await h.read(data, 0, data.length, offset);
        data = data.subarray(0, read.bytesRead);
      } finally {
        await h.close();
      }
    const nextOffset = Math.min(op.offset, size) + data.length;
    return {
      session: await processSession(dir, record),
      text: data.toString('utf8'),
      data: data.toString('base64'),
      nextOffset,
      hasMore: nextOffset < size,
    };
  }
  throw Error('Unsupported process operation');
}
