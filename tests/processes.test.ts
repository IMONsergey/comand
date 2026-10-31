import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from '../src/agent/files.js';
import { acceptDispatch, pairDevice, reconcileJobs } from '../src/agent/index.js';
import { atomicJson, jobDir, readJson, alive, type Acceptance } from '../src/agent/state.js';
import {
  executeProcessOperation,
  processScopeDir,
  processSessionDir,
  PROCESS_LOG_LIMIT,
  type ProcessScope,
  type ProcessSession,
} from '../src/agent/processes.js';
import {
  operationSchema,
  type AgentConfig,
  type Dispatch,
  type Operation,
} from '../src/shared/protocol.js';
import { createHub, type HubRuntime } from '../src/hub/server.js';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
async function until<T>(fn: () => Promise<T>, ready: (value: T) => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let result: T;
  do {
    result = await fn();
    if (ready(result)) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${JSON.stringify(result!)}`);
}
async function fixture(t: import('node:test').TestContext) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'comand-process-')));
  const root = path.join(dir, 'project');
  await mkdir(root);
  const config: AgentConfig = {
    hubUrl: 'http://127.0.0.1:1',
    deviceId: 'device',
    token: 'test',
    name: 'test',
    roots: [root],
    allowShell: true,
    allowBrowser: false,
    dataDir: path.join(dir, 'agent'),
    pollMs: 50,
    maxConcurrent: 4,
  };
  await mkdir(config.dataDir);
  let serial = 0;
  const make = (
    operation: Operation,
    id = `process-job-${++serial}`,
    projectId = 'project',
  ): Acceptance => {
    const dispatch: Dispatch = {
      project: {
        id: projectId,
        deviceId: config.deviceId,
        name: 'test',
        root,
        notes: '',
        createdAt: '',
        updatedAt: '',
      },
      job: {
        id,
        deviceId: config.deviceId,
        projectId,
        operation,
        idempotencyKey: id,
        status: 'dispatched',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        exitCode: null,
        error: null,
        result: null,
        logBytes: 0,
      },
    };
    return {
      dispatch,
      digest: hash(JSON.stringify(dispatch.job.operation)),
      acceptedAt: new Date().toISOString(),
      config: { roots: [root], allowShell: true, allowBrowser: false },
    };
  };
  const run = async (operation: unknown, id?: string, projectId?: string): Promise<any> => {
    const record = make(operationSchema.parse(operation), id, projectId);
    return executeProcessOperation(jobDir(config.dataDir, record.dispatch.job.id), record, root);
  };
  const scope: ProcessScope = {
    statePath: config.dataDir,
    deviceId: config.deviceId,
    projectId: 'project',
    root,
  };
  t.after(async () => {
    for (const projectId of ['project', 'other-project']) {
      const list = await run({ kind: 'process.list' }, undefined, projectId).catch(() => ({
        sessions: [],
      }));
      for (const session of list.sessions)
        if (session.status === 'running')
          await run(
            { kind: 'process.stop', sessionId: session.sessionId },
            undefined,
            projectId,
          ).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, root, config, make, run, scope };
}

test(
  'persistent Node REPL keeps state and deduplicates start and exact stdin delivery',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const start = {
      kind: 'process.start',
      command: `${quote(process.execPath)} -i`,
      timeoutMs: 15000,
    };
    const session: ProcessSession = await f.run(start, 'same-start-intent');
    assert.equal((await f.run(start, 'same-start-intent')).sessionId, session.sessionId);
    const input = {
      kind: 'process.input',
      sessionId: session.sessionId,
      input:
        "var total = (typeof total === 'undefined' ? 0 : total) + 1; require('fs').appendFileSync('count', 'x'); console.log('TOTAL:' + total)\n",
    };
    const first = await f.run(input, 'same-input-intent');
    assert.equal(first.acceptedBytes, Buffer.byteLength(input.input));
    assert.deepEqual(await f.run(input, 'same-input-intent'), first);
    const output = await until(
      () => f.run({ kind: 'process.output', sessionId: session.sessionId }),
      (r) => r.text.includes('TOTAL:1'),
    );
    assert.equal(await readFile(path.join(f.root, 'count'), 'utf8'), 'x');
    assert.ok(!output.text.includes('TOTAL:2'));
    await assert.rejects(
      f.run({ ...input, input: 'console.log(999)\n' }, 'same-input-intent'),
      /digest mismatch/,
    );
    const sessions = await f.run({ kind: 'process.list' });
    assert.equal(sessions.sessions.length, 1);
    assert.ok(!JSON.stringify(sessions).includes('appendFileSync'));
    assert.equal((await stat(processSessionDir(f.scope, session.sessionId))).mode & 0o777, 0o700);
    await f.run({
      kind: 'process.input',
      sessionId: session.sessionId,
      input: '',
      closeStdin: true,
    });
    const final = await until(
      () => f.run({ kind: 'process.output', sessionId: session.sessionId }),
      (r) => r.session.status === 'exited',
    );
    assert.equal(final.session.stdinClosed, true);
    assert.equal(final.session.exitCode, 0);
    await assert.rejects(
      f.run({ kind: 'process.input', sessionId: session.sessionId, input: 'oops' }),
      /stdin is unavailable/,
    );
  },
);

test(
  'Python interactive input and independent sessions remain scoped to exact project, device and state',
  { timeout: 20000 },
  async (t) => {
    if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 is unavailable');
    const f = await fixture(t);
    const a = await f.run({ kind: 'process.start', command: 'python3 -u -i -q', timeoutMs: 15000 });
    const b = await f.run(
      { kind: 'process.start', command: 'python3 -u -i -q', timeoutMs: 15000 },
      undefined,
      'other-project',
    );
    await f.run({
      kind: 'process.input',
      sessionId: a.sessionId,
      input: 'value=40\nprint(value+2)\n',
    });
    await f.run(
      { kind: 'process.input', sessionId: b.sessionId, input: 'print("SECOND")\n' },
      undefined,
      'other-project',
    );
    assert.match(
      (
        await until(
          () => f.run({ kind: 'process.output', sessionId: a.sessionId }),
          (r) => r.text.includes('42'),
        )
      ).text,
      /42/,
    );
    const second = await until(
      () => f.run({ kind: 'process.output', sessionId: b.sessionId }, undefined, 'other-project'),
      (r) => r.text.includes('SECOND'),
    );
    assert.ok(!second.text.includes('42'));
    for (const kind of ['process.output', 'process.input', 'process.stop'])
      await assert.rejects(
        f.run(
          {
            kind,
            sessionId: a.sessionId,
            ...(kind === 'process.input' ? { input: 'wrong\n' } : {}),
          },
          undefined,
          'other-project',
        ),
        /not found/,
      );
    const otherDevice = f.make(
      operationSchema.parse({ kind: 'process.output', sessionId: a.sessionId }),
    );
    otherDevice.dispatch.job.deviceId = otherDevice.dispatch.project.deviceId = 'different-device';
    await assert.rejects(
      executeProcessOperation(jobDir(f.config.dataDir, 'other-device-job'), otherDevice, f.root),
      /not found/,
    );
    const otherState = path.join(f.dir, 'another-agent');
    await mkdir(otherState);
    await assert.rejects(
      executeProcessOperation(
        jobDir(otherState, 'other-state-job'),
        f.make(operationSchema.parse({ kind: 'process.output', sessionId: a.sessionId })),
        f.root,
      ),
      /not found/,
    );
    assert.equal((await f.run({ kind: 'process.list' })).sessions.length, 1);
  },
);

test('all process controls enforce local shell opt-in and UTF-8 input byte bounds', async (t) => {
  const f = await fixture(t);
  const sessionId = `ps_${'a'.repeat(64)}`;
  for (const operation of [
    { kind: 'process.start', command: 'printf forbidden' },
    { kind: 'process.list' },
    { kind: 'process.output', sessionId },
    { kind: 'process.input', sessionId, input: 'bad' },
    { kind: 'process.stop', sessionId },
  ]) {
    const record = f.make(operationSchema.parse(operation));
    record.config.allowShell = false;
    await assert.rejects(
      executeProcessOperation(jobDir(f.config.dataDir, record.dispatch.job.id), record, f.root),
      /allow-shell/,
    );
  }
  const session = await f.run({ kind: 'process.start', command: 'cat', timeoutMs: 10000 });
  await assert.rejects(
    f.run({ kind: 'process.input', sessionId: session.sessionId, input: 'я'.repeat(40000) }),
    /65536 UTF-8 bytes/,
  );
});

test(
  'stop and timeout terminate resistant descendant groups with confirmed outcomes',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const command = "trap '' TERM; sleep 30 & echo $! > descendant.pid; wait";
    const a = await f.run({ kind: 'process.start', command, timeoutMs: 15000 });
    const pid = await until(
      async () =>
        Number(await readFile(path.join(f.root, 'descendant.pid'), 'utf8').catch(() => '0')),
      (v) => v > 0,
    );
    const stopped = await f.run(
      { kind: 'process.stop', sessionId: a.sessionId },
      'stop-once-intent',
    );
    assert.equal(stopped.status, 'stopped');
    assert.deepEqual(
      await f.run({ kind: 'process.stop', sessionId: a.sessionId }, 'stop-once-intent'),
      stopped,
    );
    await until(
      async () => alive(pid),
      (v) => !v,
    );
    const b = await f.run({ kind: 'process.start', command, timeoutMs: 1000 });
    const timed = await until(
      () => f.run({ kind: 'process.output', sessionId: b.sessionId }),
      (r) => r.session.status === 'timed_out',
    );
    assert.match(timed.session.error, /timeout/);
    assert.equal(timed.session.stdinClosed, true);
  },
);

test(
  'process output is capped and byte cursors reconstruct multibyte data without loss',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.run({
      kind: 'process.start',
      command: "printf 'Привет🙂'; head -c 11534336 /dev/zero",
      timeoutMs: 10000,
    });
    const final = await until(
      () => f.run({ kind: 'process.output', sessionId: session.sessionId }),
      (r) => r.session.status === 'exited',
    );
    assert.equal(final.session.outputBytes, PROCESS_LOG_LIMIT);
    assert.equal(final.session.truncated, true);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (let i = 0; i < 8; i++) {
      const chunk = await f.run({
        kind: 'process.output',
        sessionId: session.sessionId,
        offset,
        limit: 2,
      });
      assert.equal(chunk.nextOffset, offset + 2);
      chunks.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'Привет🙂');
    const end = await f.run({
      kind: 'process.output',
      sessionId: session.sessionId,
      offset: PROCESS_LOG_LIMIT - 100,
    });
    assert.match(end.text, /output truncated at 10 MiB/);
    assert.equal(end.hasMore, false);
  },
);

test(
  'lost broker is uncertain, cannot replay starts or stdin, and never kills a stale PID',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const command = `trap '' TERM; ${quote(process.execPath)} -e ${quote('process.on("SIGTERM",()=>{});setInterval(()=>process.stdout.write("x"),10)')} & echo $! > orphan.pid; wait`;
    const session = await f.run(
      { kind: 'process.start', command, timeoutMs: 12000 },
      'lost-broker-start',
    );
    const orphanPid = await until(
      async () => Number(await readFile(path.join(f.root, 'orphan.pid'), 'utf8').catch(() => '0')),
      (pid) => pid > 0,
    );
    const dir = processSessionDir(f.scope, session.sessionId);
    const broker = await readJson<{ pid: number }>(path.join(dir, 'broker.claim'));
    await until(
      () => f.run({ kind: 'process.output', sessionId: session.sessionId }),
      (output) => output.text.includes('x'),
    );
    process.kill(broker.pid, 'SIGKILL');
    await until(
      async () => alive(broker.pid),
      (v) => !v,
    );
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    t.after(() => unrelated.kill('SIGTERM'));
    const saved: any = await readJson(path.join(dir, 'status.json'));
    saved.heartbeat = new Date(Date.now() - 10000).toISOString();
    saved.pid = unrelated.pid; // Tampered/stale evidence must never be used as kill authority.
    saved.processGroup = unrelated.pid;
    await atomicJson(path.join(dir, 'status.json'), saved);
    assert.equal(
      (await f.run({ kind: 'process.output', sessionId: session.sessionId })).session.status,
      'uncertain',
    );
    await assert.rejects(
      f.run({ kind: 'process.start', command, timeoutMs: 12000 }, 'lost-broker-start'),
      /stale/,
    );
    await assert.rejects(
      f.run({ kind: 'process.input', sessionId: session.sessionId, input: 'must not replay\n' }),
      /stale/,
    );
    await assert.rejects(f.run({ kind: 'process.stop', sessionId: session.sessionId }), /stale/);
    assert.equal(alive(unrelated.pid), true);
    await until(
      async () => alive(orphanPid),
      (live) => !live,
    ); // Cleanup survives broken output/IPC.
  },
);

test(
  'group runner disconnected during startup never starts the command',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const dir = path.join(f.dir, 'early-disconnect');
    await mkdir(dir);
    await atomicJson(path.join(dir, 'session.json'), {
      command: 'printf started > should-not-start',
      scope: f.scope,
    });
    const runner = fileURLToPath(new URL('../src/agent/process-runner.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', runner, dir], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    child.disconnect();
    const exit = await ended;
    assert.ok(exit.code === 0 || exit.signal === 'SIGKILL', `${JSON.stringify(exit)} ${stderr}`);
    await assert.rejects(stat(path.join(f.root, 'should-not-start')), { code: 'ENOENT' });
    assert.ok(!stderr.includes('ERR_IPC_CHANNEL_CLOSED'));
  },
);

test('incomplete process acceptances count against capacity and cannot be restarted', async (t) => {
  const f = await fixture(t);
  const scopeDir = processScopeDir(f.scope);
  await mkdir(scopeDir, { recursive: true });
  for (let i = 0; i < 16; i++) await mkdir(path.join(scopeDir, `ps_${hash(`missing-${i}`)}`));
  const listed = await f.run({ kind: 'process.list' });
  assert.equal(
    listed.sessions.filter((session: ProcessSession) => session.status === 'uncertain').length,
    16,
  );
  await assert.rejects(f.run({ kind: 'process.start', command: 'printf forbidden' }), /16 active/);
  await assert.rejects(
    f.run({ kind: 'process.start', command: 'printf forbidden' }, 'missing-0'),
    /Incomplete process acceptance/,
  );
});

test(
  'normal supervisor jobs release their lock while persistent process remains interactive',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const first = f.make(
      operationSchema.parse({ kind: 'process.start', command: 'cat', timeoutMs: 15000 }),
      'supervised-start',
    );
    await acceptDispatch(f.config, first.dispatch);
    await acceptDispatch(f.config, first.dispatch);
    const status = await until(
      () => reconcileJobs(f.config),
      (jobs) => jobs.some((j) => j.jobId === first.dispatch.job.id && j.status === 'succeeded'),
    );
    const sessionId = (
      status.find((j) => j.jobId === first.dispatch.job.id)!.result as ProcessSession
    ).sessionId;
    const second = f.make(
      operationSchema.parse({ kind: 'process.input', sessionId, input: 'live-after-job\n' }),
      'supervised-input',
    );
    await acceptDispatch(f.config, second.dispatch);
    await until(
      () => reconcileJobs(f.config),
      (jobs) => jobs.some((j) => j.jobId === second.dispatch.job.id && j.status === 'succeeded'),
    );
    assert.equal(
      (
        await until(
          () => f.run({ kind: 'process.output', sessionId }),
          (r) => r.text.includes('live-after-job'),
        )
      ).session.status,
      'running',
    );
  },
);

test(
  'process state and stdin survive a real agent kill and hub restart without repeating start',
  { timeout: 40000 },
  async (t) => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'comand-process-restart-')));
    const root = path.join(dir, 'project');
    await mkdir(root);
    const agentDir = path.join(dir, 'agent'),
      hubDir = path.join(dir, 'hub');
    const token = randomBytes(32).toString('base64url');
    let hub: HubRuntime = await createHub({ dataDir: hubDir, adminToken: token, port: 0 });
    let url = await hub.start();
    let agent: ChildProcess | undefined;
    const launch = () => {
      agent = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/agent/cli.ts', 'run', '--data-dir', agentDir],
        { cwd: process.cwd(), stdio: 'ignore' },
      );
    };
    const stop = async () => {
      if (agent && agent.exitCode === null && agent.signalCode === null) {
        const closed = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));
        agent.kill('SIGKILL');
        await closed;
      }
      agent = undefined;
    };
    t.after(async () => {
      await stop();
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    });
    const config = await pairDevice({
      url,
      code: hub.store.createPairing().code,
      name: 'Process recovery',
      roots: [root],
      allowShell: true,
      dataDir: agentDir,
    });
    const project = hub.store.createProject({
      deviceId: config.deviceId,
      name: 'Process recovery',
      root,
    });
    launch();
    const startOp = operationSchema.parse({
      kind: 'process.start',
      command: `printf x >> starts; ${quote(process.execPath)} -i`,
      timeoutMs: 30000,
    });
    const start = hub.store.createJob({
      projectId: project.id,
      operation: startOp,
      idempotencyKey: 'restart-process-once',
    });
    const started = await until(
      async () => hub.store.getJob(start.id)!,
      (j) => j.status === 'succeeded',
    );
    const sessionId = (started.result as ProcessSession).sessionId;
    const send = async (input: string, key: string) => {
      const job = hub.store.createJob({
        projectId: project.id,
        operation: operationSchema.parse({ kind: 'process.input', sessionId, input }),
        idempotencyKey: key,
      });
      return until(
        async () => hub.store.getJob(job.id)!,
        (j) => j.status === 'succeeded',
      );
    };
    await send('var retained=731\n', 'state-before-restart');
    await stop();
    const port = Number(new URL(url).port);
    await hub.close();
    hub = await createHub({ dataDir: hubDir, adminToken: token, port });
    url = await hub.start();
    launch();
    assert.equal(
      hub.store.createJob({
        projectId: project.id,
        operation: startOp,
        idempotencyKey: 'restart-process-once',
      }).id,
      start.id,
    );
    await send('console.log("RETAINED:"+retained)\n', 'state-after-restart');
    const read = hub.store.createJob({
      projectId: project.id,
      operation: operationSchema.parse({ kind: 'process.output', sessionId }),
      idempotencyKey: 'output-after-restart',
    });
    const output = await until(
      async () => hub.store.getJob(read.id)!,
      (j) => j.status === 'succeeded',
    );
    assert.match((output.result as any).text, /RETAINED:731/);
    assert.equal(await readFile(path.join(root, 'starts'), 'utf8'), 'x');
    const end = hub.store.createJob({
      projectId: project.id,
      operation: { kind: 'process.stop', sessionId },
      idempotencyKey: 'stop-after-restart',
    });
    const finished = await until(
      async () => hub.store.getJob(end.id)!,
      (j) => j.status === 'succeeded',
    );
    assert.equal((finished.result as ProcessSession).status, 'stopped');
  },
);
