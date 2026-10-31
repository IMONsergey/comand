import { spawn } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson } from './state.js';
import {
  PROCESS_LOG_LIMIT,
  sameScope,
  type BrokerStatus,
  type ProcessRecord,
  type ProcessRequest,
  type ProcessReply,
} from './processes.js';

const MARKER = Buffer.from('\n[comand: process output truncated at 10 MiB]\n');
export async function runProcessBroker(dir: string) {
  const claim = await open(path.join(dir, 'broker.claim'), 'wx', 0o600).catch(() => null);
  if (!claim) return;
  await claim.writeFile(JSON.stringify({ pid: process.pid }));
  await claim.sync();
  await claim.close();
  const record = await readJson<ProcessRecord>(path.join(dir, 'session.json'));
  const status: BrokerStatus = {
    sessionId: record.sessionId,
    status: 'starting',
    createdAt: record.createdAt,
    finishedAt: null,
    exitCode: null,
    stdinClosed: false,
    outputBytes: 0,
    truncated: false,
    heartbeat: new Date().toISOString(),
  };
  let persistence = Promise.resolve();
  const persist = () => {
    const snapshot = { ...status, heartbeat: new Date().toISOString() };
    persistence = persistence.then(() => atomicJson(path.join(dir, 'status.json'), snapshot));
    return persistence;
  };
  await persist();
  const log = await open(path.join(dir, 'output.log'), 'a', 0o600);
  let writing = Promise.resolve();
  const append = (chunk: Buffer) => {
    writing = writing.then(async () => {
      if (status.truncated) return;
      const room = PROCESS_LOG_LIMIT - MARKER.length - status.outputBytes;
      const data = chunk.subarray(0, Math.max(0, room));
      if (data.length) {
        await log.write(data);
        status.outputBytes += data.length;
      }
      if (chunk.length > room) {
        await log.write(MARKER);
        status.outputBytes += MARKER.length;
        status.truncated = true;
      }
    });
    return writing.catch(() => stop('failed'));
  };
  const source = import.meta.url.endsWith('.ts');
  const runner = fileURLToPath(
    new URL(source ? './process-runner.ts' : './process-runner.js', import.meta.url),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, source ? ['--import', 'tsx', runner, dir] : [runner, dir], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
  });
  let ended = false,
    requested: 'stopped' | 'timed_out' | 'failed' | undefined;
  let exit: { code: number | null; signal: string | null } | undefined;
  let runnerError: string | undefined;
  const stop = (reason: typeof requested) => {
    if (ended || requested) return;
    requested = reason;
    if (child.connected) child.send({ stop: true }, () => {});
  };
  process.on('SIGTERM', () => stop('stopped'));
  process.on('SIGINT', () => stop('stopped'));
  child.stdin!.on('error', () => {});
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk: Buffer) => {
      // At most one chunk per pipe is awaiting disk, even for unbounded producers.
      stream.pause();
      void append(chunk).finally(() => stream.resume());
    });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    if ('ready' in message && message.ready === true) {
      status.status = 'running';
      void persist().catch(() => stop('failed'));
      if (requested && child.connected) child.send({ stop: true }, () => {});
    }
    if ('exited' in message && message.exited === true && 'code' in message && 'signal' in message)
      exit = {
        code: typeof message.code === 'number' ? message.code : null,
        signal: typeof message.signal === 'string' ? message.signal : null,
      };
    if ('error' in message && typeof message.error === 'string') runnerError = message.error;
  });
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      runnerError = error.message;
    });
    child.once('close', () => {
      ended = true;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await persist();
  const heartbeat = setInterval(() => {
    void persist().catch(() => stop('failed'));
  }, 1000);
  const timeout = setTimeout(() => stop('timed_out'), record.timeoutMs);
  const replies = new Set<Promise<unknown>>();
  const claimed = new Set<string>();
  let inputBusy = false,
    polling = false;
  const reply = (requestDir: string, body: ProcessReply) =>
    atomicJson(path.join(requestDir, 'reply.json'), body);
  const take = async (requestDir: string) => {
    const h = await open(path.join(requestDir, 'apply.claim'), 'wx', 0o600).catch(() => null);
    if (!h) return false;
    await h.writeFile('The request may have reached stdin. Never replay.');
    await h.sync();
    await h.close();
    const parent = await open(requestDir, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  };
  const poll = async () => {
    if (polling || ended) return;
    polling = true;
    try {
      for (const name of (await readdir(path.join(dir, 'requests'))).sort()) {
        if (claimed.has(name) || !/^[a-f0-9]{64}$/.test(name)) continue;
        const requestDir = path.join(dir, 'requests', name);
        const req = await readJson<ProcessRequest>(path.join(requestDir, 'request.json')).catch(
          () => null,
        );
        if (!req) continue;
        if (req.operation.kind === 'process.input' && inputBusy) continue;
        if (!(await take(requestDir))) {
          claimed.add(name);
          continue;
        }
        claimed.add(name);
        if (!sameScope(req.scope, record.scope)) {
          await reply(requestDir, { state: 'failed', error: 'Process request scope mismatch' });
          continue;
        }
        if (req.operation.kind === 'process.stop') {
          stop('stopped');
          const task = closed.then(async () => {
            await finalized;
            const { heartbeat: _, ...session } = status;
            await reply(requestDir, { state: 'done', result: session });
          });
          replies.add(task);
          task.catch(() => {}).finally(() => replies.delete(task));
          continue;
        }
        if (
          req.operation.kind !== 'process.input' ||
          Buffer.byteLength(req.operation.input) > 65_536
        ) {
          await reply(requestDir, { state: 'failed', error: 'Invalid process stdin request' });
          continue;
        }
        if (status.stdinClosed || requested || ended) {
          await reply(requestDir, { state: 'failed', error: 'Process stdin is closed' });
          continue;
        }
        inputBusy = true;
        const op = req.operation;
        const task = new Promise<void>((resolve) => {
          const complete = (error?: Error | null) => {
            const body: ProcessReply = error
              ? {
                  state: 'uncertain',
                  error:
                    'Stdin delivery failed after acceptance; some bytes may have reached the process. Do not replay.',
                }
              : {
                  state: 'done',
                  result: {
                    sessionId: record.sessionId,
                    acceptedBytes: Buffer.byteLength(op.input),
                    stdinClosed: status.stdinClosed,
                  },
                };
            void reply(requestDir, body).finally(() => {
              inputBusy = false;
              resolve();
            });
          };
          if (op.closeStdin) {
            status.stdinClosed = true;
            child.stdin!.end(op.input, 'utf8', complete);
          } else child.stdin!.write(op.input, 'utf8', complete);
        });
        replies.add(task);
        task.catch(() => {}).finally(() => replies.delete(task));
      }
    } finally {
      polling = false;
    }
  };
  const requests = setInterval(() => {
    void poll().catch(() => stop('failed'));
  }, 50);
  const finalized = closed.then(async () => {
    clearInterval(requests);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    while (polling) await new Promise((resolve) => setTimeout(resolve, 10));
    await writing;
    await log.sync();
    await log.close();
    status.finishedAt = new Date().toISOString();
    status.stdinClosed = true;
    status.exitCode = exit?.code ?? null;
    status.status = requested ?? (runnerError ? 'failed' : exit ? 'exited' : 'uncertain');
    if (runnerError) status.error = runnerError;
    else if (status.status === 'timed_out')
      status.error = `Process exceeded timeout (${record.timeoutMs} ms)`;
    else if (status.status === 'uncertain')
      status.error =
        'Process group runner exited without command outcome; work will not be replayed';
    await persist();
  });
  await finalized;
  await Promise.allSettled([...replies]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) throw Error('Missing process session state directory');
  await runProcessBroker(dir);
}
