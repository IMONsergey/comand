import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub, type HubRuntime } from '../src/hub/server.js';
import { pairDevice, agentStatus } from '../src/agent/index.js';
import { jobDir, type LocalStatus } from '../src/agent/state.js';
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
    // Exercise root aliases on Linux too, rather than relying on macOS temporary paths.
    const enrollmentRoot = join(dir, 'project-alias');
    await symlink(projectDir, enrollmentRoot);
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
      agent.on('error', (error) => {
        agentErrors += `\nAgent process error: ${error.message}`;
      });
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
      roots: [enrollmentRoot],
      allowShell: true,
      dataDir: agentDir,
    });
    // Enrollment canonicalizes device paths (for example /var -> /private/var on macOS).
    // Submit the enrolled root because the hub cannot resolve aliases on a remote device.
    assert.equal(config.roots[0], await realpath(projectDir));
    const project = hub.store.createProject({
      deviceId: config.deviceId,
      name: 'Recovery',
      root: config.roots[0]!,
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
    // Prove the detached supervisor finishes using only its own durable state while
    // both the polling agent and hub are stopped, before testing reconnect/reporting.
    const offline = await until(
      async () =>
        JSON.parse(
          await readFile(join(jobDir(agentDir, job.id), 'status.json'), 'utf8'),
        ) as LocalStatus,
      (value) => ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(value.status),
    );
    assert.equal(offline.status, 'succeeded', offline.error ?? 'Supervisor did not finish offline');
    hub = await createHub({ dataDir: hubDir, adminToken: owner, port });
    url = await hub.start();
    startAgent();
    const finished = await until(
      () => request<Job>(`/api/jobs/${job.id}`),
      (value) =>
        value.status === 'succeeded' || value.status === 'failed' || value.status === 'uncertain',
    ).catch(async (error: Error) => {
      const local = await agentStatus(agentDir).catch((statusError: Error) => ({
        error: statusError.message,
      }));
      throw new Error(
        `${error.message}\nAgent exit: ${agent?.exitCode}, signal: ${agent?.signalCode}\nAgent stderr: ${agentErrors}\nLocal state: ${JSON.stringify(local)}`,
      );
    });
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
