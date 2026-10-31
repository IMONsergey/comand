import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeFileOperation } from '../src/agent/files.js';
import { acceptDispatch, reconcileJobs, cancelLocalJob, resolveJob } from '../src/agent/index.js';
import type { AgentConfig, Dispatch } from '../src/shared/protocol.js';
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'comand-agent-'));
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
    dataDir: path.join(dir, 'state'),
    pollMs: 50,
    maxConcurrent: 2,
  };
  return { dir, root, config };
}
function dispatch(root: string, id: string, command: string): Dispatch {
  return {
    project: {
      id: 'project',
      deviceId: 'device',
      name: 'test',
      root,
      notes: '',
      createdAt: '',
      updatedAt: '',
    },
    job: {
      id,
      deviceId: 'device',
      projectId: 'project',
      operation: { kind: 'command', command, timeoutMs: 10000 },
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
}
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Timed out');
}
test('file APIs reject traversal, symlink mutation and hash conflicts', async () => {
  const f = await fixture();
  try {
    const run = (op: any) => executeFileOperation(op, f.root, f.config.roots);
    await run({ kind: 'files.write', path: 'a', content: 'hello', createOnly: true });
    const a: any = await run({ kind: 'files.read', path: 'a', offset: 0, limit: 100 });
    assert.equal(a.content, 'hello');
    await assert.rejects(
      run({ kind: 'files.write', path: 'a', content: 'wrong', expectedHash: '0'.repeat(64) }),
      /conflict/i,
    );
    await assert.rejects(
      run({ kind: 'files.read', path: '../outside', offset: 0, limit: 100 }),
      /path/i,
    );
    await symlink(path.join(f.root, 'a'), path.join(f.root, 'link'));
    await assert.rejects(run({ kind: 'files.write', path: 'link', content: 'bad' }), /symlink/i);
    assert.equal(await readFile(path.join(f.root, 'a'), 'utf8'), 'hello');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('duplicate dispatch and agent restart never repeat accepted command', async () => {
  const f = await fixture();
  try {
    const d = dispatch(f.root, 'duplicate-job', 'printf x >> counter; sleep 0.3; printf finished');
    await acceptDispatch(f.config, d);
    await acceptDispatch(f.config, d);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'succeeded'));
    await acceptDispatch(f.config, d);
    assert.equal(await readFile(path.join(f.root, 'counter'), 'utf8'), 'x');
    const jobs = await reconcileJobs(f.config);
    assert.equal(jobs[0]?.status, 'succeeded');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('cancellation reaches supervisor process group and retains cancellation evidence', async () => {
  const f = await fixture();
  try {
    await acceptDispatch(f.config, dispatch(f.root, 'cancel-job', 'sleep 20 & wait'));
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'running'));
    await cancelLocalJob(f.config.dataDir, 'cancel-job');
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'cancelled'));
    assert.equal((await reconcileJobs(f.config))[0]?.status, 'cancelled');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('dead supervisor becomes uncertain and retains the project lock', async () => {
  const f = await fixture();
  try {
    const d = dispatch(f.root, 'lost-supervisor', 'sleep 20');
    await acceptDispatch(f.config, d);
    await until(async () =>
      (await reconcileJobs(f.config)).some((j) => j.status === 'running' && !!j.processGroup),
    );
    const status = (await reconcileJobs(f.config))[0]!;
    process.kill(status.pid!, 'SIGKILL');
    try {
      process.kill(-status.processGroup!, 'SIGKILL');
    } catch {}
    const { jobDir, readJson, atomicJson } = await import('../src/agent/state.js');
    const recordFile = path.join(jobDir(f.config.dataDir, d.job.id), 'accepted.json');
    const record: any = await readJson(recordFile);
    record.acceptedAt = new Date(Date.now() - 10000).toISOString();
    await atomicJson(recordFile, record);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'uncertain'));
    await assert.rejects(
      acceptDispatch(f.config, dispatch(f.root, 'second-job', 'printf bad')),
      /locked/,
    );
    assert.equal(await acceptDispatch(f.config, d), false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('logs have a strict byte cap and explicit truncation marker', async () => {
  const f = await fixture();
  try {
    await acceptDispatch(f.config, dispatch(f.root, 'large-log', 'head -c 11534336 /dev/zero'));
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'succeeded'));
    const { jobDir } = await import('../src/agent/state.js');
    const output = await readFile(path.join(jobDir(f.config.dataDir, 'large-log'), 'output.log'));
    assert.equal(output.length, 10 * 1024 * 1024);
    assert.match(output.subarray(-100).toString(), /log truncated at 10 MiB/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('timeout terminates the command group and reports failure', async () => {
  const f = await fixture();
  try {
    const d = dispatch(f.root, 'timeout-job', 'sleep 20 & wait');
    if (d.job.operation.kind === 'command') d.job.operation.timeoutMs = 1000;
    await acceptDispatch(f.config, d);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'failed'));
    assert.match((await reconcileJobs(f.config))[0]?.error ?? '', /timeout/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('pairing persists private credentials and rejects external cleartext hubs', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  const { pairDevice, agentStatus } = await import('../src/agent/index.js');
  const { stat } = await import('node:fs/promises');
  let enrollment: any;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    enrollment = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deviceId: 'device', token: 'private-test-token' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const config = await pairDevice({
      url: `http://127.0.0.1:${address.port}`,
      code: '123456',
      name: 'test',
      roots: [f.root],
      allowShell: true,
      dataDir: f.config.dataDir,
    });
    assert.equal(enrollment.pairingCode, '123456');
    assert.equal(config.token, 'private-test-token');
    assert.equal((await stat(path.join(f.config.dataDir, 'config.json'))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(await agentStatus(f.config.dataDir)).includes('private-test-token'));
    await assert.rejects(
      pairDevice({
        url: 'http://example.com',
        code: 'code',
        name: 'test',
        roots: [f.root],
        dataDir: f.config.dataDir,
      }),
      /HTTPS/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('interrupted acceptance is recovered as uncertain without running it', async () => {
  const f = await fixture();
  try {
    const { lockDir, atomicJson, jobDir } = await import('../src/agent/state.js');
    const d = dispatch(f.root, 'interrupted-job', 'touch should-not-exist');
    const record = {
      dispatch: d,
      digest: 'interrupted',
      acceptedAt: new Date(Date.now() - 10000).toISOString(),
      config: { roots: f.config.roots, allowShell: true, allowBrowser: false },
    };
    await atomicJson(path.join(lockDir(f.config.dataDir, d.project.id), 'owner.json'), {
      jobId: d.job.id,
      record,
    });
    const jobs = await reconcileJobs(f.config);
    assert.equal(jobs[0]?.status, 'uncertain');
    await assert.rejects(readFile(path.join(f.root, 'should-not-exist')), { code: 'ENOENT' });
    assert.ok(await readFile(path.join(jobDir(f.config.dataDir, d.job.id), 'accepted.json')));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('duplicate replay syncs saved success after its project root disappears', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  const { pollOnce } = await import('../src/agent/index.js');
  const d = dispatch(f.root, 'removed-root-job', 'printf completed');
  const updates: any[] = [];
  let mismatch = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/poll') {
      const replay = mismatch
        ? { ...d, job: { ...d.job, operation: { ...d.job.operation, command: 'different' } } }
        : d;
      res.end(
        JSON.stringify({ jobs: [replay], cancellations: [], serverTime: new Date().toISOString() }),
      );
    } else {
      updates.push(body);
      res.end(
        JSON.stringify({
          logBytes: body.log ? body.log.offset + Buffer.from(body.log.data, 'base64').length : 9,
          status: body.status,
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    f.config.hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await acceptDispatch(f.config, d);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'succeeded'));
    await rm(f.root, { recursive: true });
    assert.equal(await acceptDispatch(f.config, d), false);
    mismatch = true;
    await assert.rejects(pollOnce(f.config), /digest mismatch/);
    assert.ok(updates.some((update) => update.status === 'succeeded'));
    assert.ok(!updates.some((update) => update.status === 'failed'));
    mismatch = false;
    const acknowledgedUpdates = updates.length;
    await pollOnce(f.config);
    assert.equal(
      updates.length,
      acknowledgedUpdates,
      'acknowledged terminal results are not uploaded again',
    );
    assert.equal((await reconcileJobs(f.config))[0]?.status, 'succeeded');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('uncertain resolution rejects a live orphan process group after its leader dies', async () => {
  const f = await fixture();
  const { jobDir, readJson, atomicJson, alive, processGroupAlive } =
    await import('../src/agent/state.js');
  let pgid: number | undefined;
  try {
    await atomicJson(path.join(f.config.dataDir, 'config.json'), f.config);
    const d = dispatch(f.root, 'orphan-group-job', 'sleep 60 & echo $! > child.pid; wait');
    await acceptDispatch(f.config, d);
    await until(
      async () =>
        !!(await reconcileJobs(f.config))[0]?.processGroup &&
        (await readFile(path.join(f.root, 'child.pid'), 'utf8').then(
          () => true,
          () => false,
        )),
    );
    const status = (await reconcileJobs(f.config))[0]!;
    pgid = status.processGroup!;
    const childPid = Number(await readFile(path.join(f.root, 'child.pid'), 'utf8'));
    process.kill(status.pid!, 'SIGKILL');
    process.kill(pgid, 'SIGKILL');
    await until(async () => !alive(status.pid) && !alive(pgid));
    assert.equal(alive(childPid), true);
    const recordFile = path.join(jobDir(f.config.dataDir, d.job.id), 'accepted.json');
    const record: any = await readJson(recordFile);
    record.acceptedAt = new Date(Date.now() - 10000).toISOString();
    await atomicJson(recordFile, record);
    await reconcileJobs(f.config);
    await assert.rejects(resolveJob(f.config.dataDir, d.job.id), /live process/);
    assert.equal((await reconcileJobs(f.config))[0]?.status, 'uncertain');
    process.kill(-pgid, 'SIGKILL');
    await until(async () => !processGroupAlive(pgid));
    assert.equal((await resolveJob(f.config.dataDir, d.job.id)).status, 'failed');
  } finally {
    if (pgid)
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('concurrent file moves never replace the winning destination or lose the other source', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'a'), 'alpha');
    await writeFile(path.join(f.root, 'b'), 'beta');
    const move = (from: string) =>
      executeFileOperation({ kind: 'files.move', from, to: 'destination' }, f.root, f.config.roots);
    const results = await Promise.allSettled([move('a'), move('b')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const winningSource = results[0]?.status === 'fulfilled' ? 'a' : 'b';
    const losingSource = winningSource === 'a' ? 'b' : 'a';
    assert.equal(
      await readFile(path.join(f.root, 'destination'), 'utf8'),
      winningSource === 'a' ? 'alpha' : 'beta',
    );
    assert.equal(
      await readFile(path.join(f.root, losingSource), 'utf8'),
      losingSource === 'a' ? 'alpha' : 'beta',
    );
    await assert.rejects(readFile(path.join(f.root, winningSource)), { code: 'ENOENT' });
    await mkdir(path.join(f.root, 'directory'));
    await assert.rejects(move('directory'), /regular files only/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('different project IDs and symlink aliases share a canonical root execution lock', async () => {
  const f = await fixture();
  try {
    const first = dispatch(f.root, 'root-lock-first', 'sleep 20');
    await acceptDispatch(f.config, first);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'running'));
    const alias = path.join(f.dir, 'root-alias');
    await symlink(f.root, alias);
    const second = dispatch(alias, 'root-lock-second', 'touch duplicate');
    second.project.id = 'other-project';
    second.job.projectId = 'other-project';
    await assert.rejects(acceptDispatch(f.config, second), /locked/);
    await cancelLocalJob(f.config.dataDir, first.job.id);
    await until(async () => (await reconcileJobs(f.config)).some((j) => j.status === 'cancelled'));
    await acceptDispatch(f.config, second);
    await until(async () =>
      (await reconcileJobs(f.config)).some(
        (j) => j.jobId === second.job.id && j.status === 'succeeded',
      ),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('browser launcher uses disposable Chrome fallback only for a missing bundled executable', async () => {
  const { launchInspectionBrowser } = await import('../src/agent/browser.js');
  const calls: unknown[] = [];
  const fakeBrowser = {} as import('playwright').Browser;
  const launcher = {
    launch: async (options: unknown) => {
      calls.push(options);
      if (calls.length === 1) throw Error("Executable doesn't exist at /missing/chromium");
      return fakeBrowser;
    },
  };
  assert.equal(
    await launchInspectionBrowser(launcher, {
      channel: '',
      platform: 'darwin',
      executableExists: async (file) =>
        file === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }),
    fakeBrowser,
  );
  assert.deepEqual(calls, [{ headless: true }, { headless: true, channel: 'chrome' }]);
  const explicit: unknown[] = [];
  await launchInspectionBrowser(
    {
      launch: async (options) => {
        explicit.push(options);
        return fakeBrowser;
      },
    },
    { channel: 'chrome' },
  );
  assert.deepEqual(explicit, [{ headless: true, channel: 'chrome' }]);
  await assert.rejects(
    launchInspectionBrowser(launcher, { channel: 'other' }),
    /must be chrome or chromium/,
  );
  await assert.rejects(
    launchInspectionBrowser(
      {
        launch: async () => {
          throw Error("Executable doesn't exist at /missing/chromium");
        },
      },
      { channel: '', platform: 'darwin', executableExists: async () => false },
    ),
    /npx playwright install chromium/,
  );
});
