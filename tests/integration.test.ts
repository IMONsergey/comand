import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub, type HubRuntime } from '../src/hub/server.js';
import { pairDevice } from '../src/agent/index.js';
import type { Job } from '../src/shared/protocol.js';

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 15_000,
): Promise<T> {
  const start = Date.now();
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await delay(60);
  } while (Date.now() - start < timeout);
  throw Error(`Timed out waiting for state; last value ${JSON.stringify(value)}`);
}

test(
  'real device command survives agent kill and hub restart with one execution and complete logs',
  { timeout: 30_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'comand-integration-'));
    const projectDir = join(dir, 'project');
    await mkdir(projectDir);
    const agentDir = join(dir, 'agent');
    const hubDir = join(dir, 'hub');
    const owner = randomBytes(32).toString('base64url');
    let hub: HubRuntime = await createHub({ dataDir: hubDir, adminToken: owner, port: 0 });
    let url = await hub.start();
    let agent: ChildProcess | undefined;
    let agentErrors = '';
    const startAgent = () => {
      agent = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/agent/cli.ts', 'run', '--data-dir', agentDir],
        { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe'] },
      );
      agent.stderr?.on('data', (data) => {
        agentErrors = (agentErrors + String(data)).slice(-8000);
      });
    };
    const stopAgent = async (signal: NodeJS.Signals) => {
      if (agent && agent.exitCode === null && agent.signalCode === null) {
        const stopped = new Promise<void>((r) => agent!.once('exit', () => r()));
        agent.kill(signal);
        await stopped;
      }
      agent = undefined;
    };
    t.after(async () => {
      await stopAgent('SIGTERM');
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    });
    const config = await pairDevice({
      url,
      code: hub.store.createPairing().code,
      name: 'Recovery fixture',
      roots: [projectDir],
      allowShell: true,
      dataDir: agentDir,
    });
    const project = hub.store.createProject({
      deviceId: config.deviceId,
      name: 'Recovery',
      root: projectDir,
    });
    startAgent();
    const request = async <T>(path: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw Error(JSON.stringify(json));
      return json as T;
    };
    const payload = {
      projectId: project.id,
      idempotencyKey: 'survive-disconnection-01',
      operation: {
        kind: 'command',
        command:
          "printf 'run\\n' >> executions.txt; printf 'начало\\n'; sleep 2; printf 'готово\\n'",
        timeoutMs: 10_000,
      },
    };
    const job = await request<Job>('/api/jobs', payload);
    await until(
      () => request<Job>(`/api/jobs/${job.id}`),
      (value) => value.status === 'running',
    );
    await stopAgent('SIGKILL');
    const port = Number(new URL(url).port);
    await hub.close();
    await delay(1500);
    hub = await createHub({ dataDir: hubDir, adminToken: owner, port });
    url = await hub.start();
    startAgent();
    const finished = await until(
      () => request<Job>(`/api/jobs/${job.id}`),
      (value) =>
        value.status === 'succeeded' || value.status === 'failed' || value.status === 'uncertain',
    );
    assert.equal(finished.status, 'succeeded', `${finished.error ?? ''}\n${agentErrors}`);
    assert.equal(await readFile(join(projectDir, 'executions.txt'), 'utf8'), 'run\n');
    const replay = await request<Job>('/api/jobs', payload);
    assert.equal(replay.id, job.id);
    const logs = await request<{ text: string }>(`/api/jobs/${job.id}/logs`);
    assert.match(logs.text, /начало/);
    assert.match(logs.text, /готово/);
    const written = await request<Job>('/api/jobs', {
      projectId: project.id,
      idempotencyKey: 'create-file-01',
      operation: {
        kind: 'files.write',
        path: 'hello.txt',
        content: 'Привет, Comand',
        createOnly: true,
      },
    });
    assert.equal(
      (
        await until(
          () => request<Job>(`/api/jobs/${written.id}`),
          (value) => ['succeeded', 'failed'].includes(value.status),
        )
      ).status,
      'succeeded',
    );
    assert.equal(await readFile(join(projectDir, 'hello.txt'), 'utf8'), 'Привет, Comand');
  },
);
