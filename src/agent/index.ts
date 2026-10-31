import { spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  chmod,
  realpath,
  stat,
  unlink,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  MAX_LOG_CHUNK,
  terminalStates,
  operationSchema,
  type AgentConfig,
  type AgentCredentials,
  type Dispatch,
  type PollResponse,
  type JobUpdate,
} from '../shared/protocol.js';
import { hash, projectRoot } from './files.js';
import {
  jobDir,
  lockDir,
  atomicJson,
  readJson,
  alive,
  processGroupAlive,
  acceptances,
  releaseLock,
  type Acceptance,
  type LocalStatus,
} from './state.js';
export interface PairOptions {
  url: string;
  code: string;
  name: string;
  roots: string[];
  allowShell?: boolean;
  allowBrowser?: boolean;
  dataDir: string;
}
export function validateHubUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw Error('Hub URL must not contain credentials, query or fragment');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw Error('Remote hubs require HTTPS; HTTP is allowed only on loopback');
  return url.href.replace(/\/$/, '');
}
async function request<T>(
  config: Pick<AgentConfig, 'hubUrl' | 'token'>,
  route: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(config.hubUrl + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw Error(data.error ?? `Hub returned HTTP ${response.status}`);
  return data;
}
export async function pairDevice(options: PairOptions): Promise<AgentConfig> {
  if (!options.name.trim() || options.name.length > 100)
    throw Error('Device name must contain 1–100 characters');
  if (!options.roots.length) throw Error('Specify at least one --root');
  const roots = [
    ...new Set(
      await Promise.all(
        options.roots.map(async (root) => {
          if (!path.isAbsolute(root)) throw Error('Approved roots must be absolute paths');
          const value = await realpath(root);
          if (!(await stat(value)).isDirectory()) throw Error('Approved root must be a directory');
          return value;
        }),
      ),
    ),
  ];
  const hubUrl = validateHubUrl(options.url);
  const dataDir = path.resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    await readFile(path.join(dataDir, 'config.json'));
    throw Error('This data directory is already paired; use another --data-dir');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const credentials = await request<AgentCredentials>({ hubUrl, token: '' }, '/api/agent/enroll', {
    pairingCode: options.code,
    name: options.name,
    platform: process.platform,
    roots,
    allowShell: !!options.allowShell,
    allowBrowser: !!options.allowBrowser,
    version: VERSION,
  });
  const config: AgentConfig = {
    hubUrl,
    ...credentials,
    name: options.name,
    roots,
    allowShell: !!options.allowShell,
    allowBrowser: !!options.allowBrowser,
    dataDir,
    pollMs: 1000,
    maxConcurrent: 4,
  };
  await atomicJson(path.join(dataDir, 'config.json'), config);
  await chmod(path.join(dataDir, 'config.json'), 0o600);
  return config;
}
export async function loadConfig(dataDir: string): Promise<AgentConfig> {
  const config = await readJson<AgentConfig>(path.join(dataDir, 'config.json'));
  validateHubUrl(config.hubUrl);
  config.dataDir = path.resolve(dataDir);
  return config;
}
export async function acceptDispatch(config: AgentConfig, dispatch: Dispatch): Promise<boolean> {
  if (
    dispatch.job.deviceId !== config.deviceId ||
    dispatch.project.deviceId !== config.deviceId ||
    dispatch.project.id !== dispatch.job.projectId
  )
    throw Error('Dispatch device/project mismatch');
  operationSchema.parse(dispatch.job.operation);
  const dir = jobDir(config.dataDir, dispatch.job.id);
  const digest = hash(
    JSON.stringify({
      id: dispatch.job.id,
      project: dispatch.project.id,
      root: dispatch.project.root,
      operation: dispatch.job.operation,
    }),
  );
  try {
    const previous = await readJson<Acceptance>(path.join(dir, 'accepted.json'));
    if (previous.digest !== digest) throw Error('Accepted job payload digest mismatch');
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const canonicalRoot = await projectRoot(dispatch.project.root, config.roots);
  const record: Acceptance = {
    lockKey: `root:${canonicalRoot}`,
    dispatch,
    digest,
    acceptedAt: new Date().toISOString(),
    config: {
      roots: config.roots,
      allowShell: config.allowShell,
      allowBrowser: config.allowBrowser,
    },
  };
  await mkdir(path.join(config.dataDir, 'locks'), { recursive: true, mode: 0o700 });
  const lock = lockDir(config.dataDir, record.lockKey!);
  try {
    await mkdir(lock, { mode: 0o700 });
    await atomicJson(path.join(lock, 'owner.json'), { jobId: dispatch.job.id, record });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const owner = await readJson<{ jobId: string }>(path.join(lock, 'owner.json')).catch(
      () => null,
    );
    if (owner?.jobId !== dispatch.job.id)
      throw Error('Project is locked by an active or uncertain job');
  }
  await mkdir(path.join(config.dataDir, 'jobs'), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw Error('Incomplete accepted job evidence; refusing to replay');
    throw e;
  }
  await atomicJson(path.join(dir, 'accepted.json'), record);
  const supervisor = fileURLToPath(new URL('./supervisor.js', import.meta.url));
  const source = import.meta.url.endsWith('.ts');
  const args = source
    ? ['--import', 'tsx', supervisor.replace(/\.js$/, '.ts'), dir]
    : [supervisor, dir];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await atomicJson(path.join(dir, 'spawn.json'), {
    pid: child.pid,
    spawnedAt: new Date().toISOString(),
  });
  child.unref();
  return true;
}
export async function reconcileJobs(config: AgentConfig): Promise<LocalStatus[]> {
  // A crash after locking but before acceptance publication must remain visible and never replay.
  const locks = await readdir(path.join(config.dataDir, 'locks')).catch(() => [] as string[]);
  for (const name of locks) {
    const lock = path.join(config.dataDir, 'locks', name);
    const owner = await readJson<{ jobId: string; record?: Acceptance }>(
      path.join(lock, 'owner.json'),
    ).catch(() => null);
    if (owner?.record && Date.now() - Date.parse(owner.record.acceptedAt) > 5000) {
      const dir = jobDir(config.dataDir, owner.jobId);
      const accepted = await readJson<Acceptance>(path.join(dir, 'accepted.json')).catch(
        () => null,
      );
      if (!accepted) {
        await atomicJson(path.join(dir, 'accepted.json'), owner.record);
        await atomicJson(path.join(dir, 'status.json'), {
          jobId: owner.jobId,
          status: 'uncertain',
          error:
            'Acceptance was interrupted before supervisor startup. Explicit resolution is required; work was not replayed.',
        });
      }
    } else if (!owner) {
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 5000) {
        const known = (await acceptances(config.dataDir)).some(
          (x) => lockDir(config.dataDir, x.record.lockKey ?? x.record.dispatch.project.id) === lock,
        );
        if (!known) await rm(lock, { recursive: true, force: true });
      }
    }
  }
  const result: LocalStatus[] = [];
  for (const { dir, record } of await acceptances(config.dataDir)) {
    let status = await readJson<LocalStatus>(path.join(dir, 'status.json')).catch(() => null);
    const spawn = await readJson<{ pid: number }>(path.join(dir, 'spawn.json')).catch(() => null);
    if (!status || !terminalStates.has(status.status)) {
      const pid = status?.pid ?? spawn?.pid;
      const age = Date.now() - Date.parse(record.acceptedAt);
      if (
        age > 5000 &&
        (!alive(pid) || (status?.heartbeat && Date.now() - Date.parse(status.heartbeat) > 30000))
      ) {
        status = {
          ...status,
          jobId: record.dispatch.job.id,
          status: 'uncertain',
          error:
            'Accepted job lost its supervisor evidence. It will not be replayed. Inspect the device, then explicitly resolve it.',
        };
        await atomicJson(path.join(dir, 'status.json'), status);
      }
    }
    if (status) {
      if (terminalStates.has(status.status))
        await releaseLock(
          config.dataDir,
          record.lockKey ?? record.dispatch.project.id,
          record.dispatch.job.id,
        );
      result.push(status);
    }
  }
  return result;
}
export async function cancelLocalJob(dataDir: string, id: string) {
  const dir = jobDir(dataDir, id);
  await readJson<Acceptance>(path.join(dir, 'accepted.json'));
  const h = await open(path.join(dir, 'cancel'), 'a', 0o600);
  await h.sync();
  await h.close();
}
export async function resolveJob(dataDir: string, id: string): Promise<LocalStatus> {
  const config = await loadConfig(dataDir);
  await reconcileJobs(config);
  const dir = jobDir(dataDir, id);
  const record = await readJson<Acceptance>(path.join(dir, 'accepted.json'));
  const current = await readJson<LocalStatus>(path.join(dir, 'status.json'));
  if (current.status !== 'uncertain')
    throw Error('Only an uncertain job can be explicitly resolved');
  if (alive(current.pid) || processGroupAlive(current.processGroup))
    throw Error('Job still has a live process; inspect and stop it first');
  const status: LocalStatus = {
    jobId: id,
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error: 'Owner acknowledged uncertain outcome and released project lock. Work was not replayed.',
  };
  await atomicJson(path.join(dir, 'status.json'), status);
  await releaseLock(dataDir, record.lockKey ?? record.dispatch.project.id, id);
  return status;
}
export async function agentStatus(dataDir: string) {
  const config = await loadConfig(dataDir);
  const { token, ...safe } = config;
  const daemon = await readJson<{ pid: number; startedAt: string }>(
    path.join(dataDir, 'daemon.json'),
  ).catch(() => null);
  return {
    config: safe,
    running: alive(daemon?.pid),
    pid: daemon?.pid ?? null,
    startedAt: daemon?.startedAt ?? null,
    jobs: await reconcileJobs(config),
  };
}
export async function syncJobs(config: AgentConfig) {
  const errors: Error[] = [];
  for (const status of await reconcileJobs(config)) {
    try {
      const dir = jobDir(config.dataDir, status.jobId);
      const saved = await readJson<{ offset: number; syncedStatus?: string }>(
        path.join(dir, 'ack.json'),
      ).catch(() => ({ offset: 0, syncedStatus: undefined }));
      if (terminalStates.has(status.status) && saved.syncedStatus === status.status) continue;
      let offset = saved.offset;
      const log = await readFile(path.join(dir, 'output.log')).catch(() => Buffer.alloc(0));
      const { pid, heartbeat, processGroup, ...base } = status;
      // Preserve the current state on every log chunk; reconnect must never regress a saved outcome.
      while (offset < log.length) {
        const data = log.subarray(offset, offset + MAX_LOG_CHUNK);
        const update: JobUpdate = { ...base, log: { offset, data: data.toString('base64') } };
        const ack = await request<{ logBytes: number; status: string }>(
          config,
          `/api/agent/jobs/${encodeURIComponent(status.jobId)}/update`,
          update,
        );
        offset = ack.logBytes;
        await atomicJson(path.join(dir, 'ack.json'), { offset });
        if (offset < update.log!.offset + data.length)
          throw Error('Hub did not acknowledge log bytes');
      }
      await request(config, `/api/agent/jobs/${encodeURIComponent(status.jobId)}/update`, base);
      if (terminalStates.has(status.status))
        await atomicJson(path.join(dir, 'ack.json'), { offset, syncedStatus: status.status });
    } catch (e) {
      errors.push(e instanceof Error ? e : Error(String(e)));
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((e) => e.message).join('; '));
}
export async function pollOnce(config: AgentConfig) {
  await reconcileJobs(config);
  const response = await request<PollResponse>(config, '/api/agent/poll', {});
  const errors: Error[] = [];
  for (const id of response.cancellations) await cancelLocalJob(config.dataDir, id).catch(() => {});
  for (const dispatch of response.jobs) {
    try {
      let activeCount = 0;
      for (const { dir } of await acceptances(config.dataDir)) {
        const state = await readJson<LocalStatus>(path.join(dir, 'status.json')).catch(() => null);
        if (!state || !terminalStates.has(state.status)) activeCount++;
      }
      if (activeCount >= config.maxConcurrent) continue;
      await acceptDispatch(config, dispatch);
    } catch (e) {
      errors.push(e instanceof Error ? e : Error(String(e)));
      const existing = await readJson<Acceptance>(
        path.join(jobDir(config.dataDir, dispatch.job.id), 'accepted.json'),
      ).catch(() => null);
      // Saved outcomes remain authoritative even if a replay is malformed or its root disappeared.
      if (!existing) {
        try {
          await request(config, `/api/agent/jobs/${encodeURIComponent(dispatch.job.id)}/update`, {
            jobId: dispatch.job.id,
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
            finishedAt: new Date().toISOString(),
          });
        } catch (updateError) {
          errors.push(updateError instanceof Error ? updateError : Error(String(updateError)));
        }
      }
    }
  }
  for (const id of response.cancellations) await cancelLocalJob(config.dataDir, id).catch(() => {});
  try {
    await syncJobs(config);
  } catch (e) {
    errors.push(e instanceof Error ? e : Error(String(e)));
  }
  if (errors.length) throw new AggregateError(errors, errors.map((e) => e.message).join('; '));
}
export async function runAgent(
  configOrDir: AgentConfig | string,
  options: { signal?: AbortSignal; onError?: (error: Error) => void } = {},
) {
  const config = typeof configOrDir === 'string' ? await loadConfig(configOrDir) : configOrDir;
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const daemon = path.join(config.dataDir, 'daemon.json');
  const acquire = async () => {
    const h = await open(daemon, 'wx', 0o600);
    await h.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await h.sync();
    await h.close();
  };
  try {
    await acquire();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const owner = await readJson<{ pid: number }>(daemon);
    if (alive(owner.pid)) throw Error('An agent is already running for this data directory');
    await unlink(daemon);
    await acquire();
  }
  try {
    while (!options.signal?.aborted) {
      try {
        await pollOnce(config);
      } catch (e) {
        options.onError?.(e instanceof Error ? e : Error(String(e)));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, config.pollMs);
        function done() {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', done);
          resolve();
        }
        options.signal?.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    await unlink(daemon).catch(() => {});
  }
}
