import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHub } from '../src/hub/server.js';
const adminToken = 'test-owner-token-with-more-than-32-characters';
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'comand-hub-'));
  const hub = await createHub({ dataDir, adminToken, port: 0 });
  const url = await hub.start();
  const request = (
    path: string,
    body?: unknown,
    token = adminToken,
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const enroll = () =>
    hub.store.enroll({
      pairingCode: hub.store.createPairing().code,
      name: 'Linux',
      platform: 'linux',
      roots: ['/work'],
      allowShell: true,
      allowBrowser: false,
      version: '0.1.0',
    });
  return {
    hub,
    url,
    dataDir,
    request,
    enroll,
    close: async () => {
      await hub.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
test('HTTP authentication, CSRF and no credentials in device outputs', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}/api/devices`)).status, 401);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${f.url}/health`,
        { headers: { host: 'attacker.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostileHostStatus, 403);
    f.hub.app.get('/api/connections', (_req, res) => res.json({ extension: true }));
    assert.deepEqual(await (await f.request('/api/connections')).json(), { extension: true });
    assert.equal(
      (
        await fetch(`${f.url}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
          body: JSON.stringify({ token: adminToken }),
        })
      ).status,
      403,
    );
    const login = await fetch(`${f.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: f.url },
      body: JSON.stringify({ token: adminToken }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as {
      csrfToken: string;
    };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal(
      (await fetch(`${f.url}/api/pairings`, { method: 'POST', headers: { cookie, origin: f.url } }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/pairings`, {
          method: 'POST',
          headers: { cookie, origin: f.url, 'x-comand-csrf': session.csrfToken },
        })
      ).status,
      201,
    );
    const credentials = f.enroll();
    assert.ok(!JSON.stringify(f.hub.store.listDevices()).includes(credentials.token));
  } finally {
    await f.close();
  }
});
test('persistent dispatch, idempotency, isolation, log replay, lock and cancellation', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    const other = f.enroll();
    const project = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Project',
      root: '/work/project',
    });
    const input = {
      projectId: project.id,
      idempotencyKey: 'one-operation',
      operation: { kind: 'command' as const, command: 'echo hello', timeoutMs: 1000 },
    };
    const first = await f.request('/api/jobs', input);
    assert.equal(first.status, 201);
    const job = (await first.json()) as {
      id: string;
    };
    assert.equal((await f.request('/api/jobs', input)).status, 200);
    assert.equal(
      (
        await f.request('/api/jobs', {
          ...input,
          operation: { ...input.operation, command: 'different' },
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request('/api/jobs', { ...input, idempotencyKey: 'another-operation' })).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          `/api/agent/jobs/${job.id}/update`,
          { jobId: job.id, status: 'running' },
          device.token,
        )
      ).status,
      409,
    );
    assert.equal(f.hub.store.poll(device.deviceId).jobs[0]?.job.id, job.id);
    assert.equal(f.hub.store.poll(device.deviceId).jobs[0]?.job.id, job.id);
    assert.equal(
      (
        await f.request(
          `/api/agent/jobs/${job.id}/update`,
          { jobId: job.id, status: 'running' },
          other.token,
        )
      ).status,
      403,
    );
    const update = {
      jobId: job.id,
      status: 'running',
      log: { offset: 0, data: Buffer.from('привет\n').toString('base64') },
    };
    assert.equal(
      (await f.request(`/api/agent/jobs/${job.id}/update`, update, device.token)).status,
      200,
    );
    assert.equal(
      (await f.request(`/api/agent/jobs/${job.id}/update`, update, device.token)).status,
      200,
    );
    assert.equal(f.hub.store.getLogs(job.id).text, 'привет\n');
    assert.equal(
      (
        await f.request(
          `/api/agent/jobs/${job.id}/update`,
          { ...update, log: { offset: 1, data: Buffer.from('bad').toString('base64') } },
          device.token,
        )
      ).status,
      409,
    );
    assert.equal(f.hub.store.cancelJob(job.id).status, 'running');
    assert.deepEqual(f.hub.store.poll(device.deviceId).cancellations, [job.id]);
    f.hub.store.updateJob(device.deviceId, {
      jobId: job.id,
      status: 'uncertain',
      error: 'lost evidence',
    });
    assert.equal(
      (await f.request('/api/jobs', { ...input, idempotencyKey: 'third-operation' })).status,
      409,
    );
    f.hub.store.updateJob(device.deviceId, { jobId: job.id, status: 'cancelled' });
    assert.equal(
      (
        await f.request(
          `/api/agent/jobs/${job.id}/update`,
          { jobId: job.id, status: 'running' },
          device.token,
        )
      ).status,
      409,
    );
    f.hub.store.revokeDevice(device.deviceId);
    assert.equal((await f.request('/api/agent/poll', {}, device.token)).status, 401);
    await f.hub.close();
    const restarted = await createHub({ dataDir: f.dataDir, adminToken, port: 0 });
    assert.equal(restarted.store.getJob(job.id)?.status, 'cancelled');
    assert.equal(restarted.store.getLogs(job.id).text, 'привет\n');
    await restarted.close();
  } finally {
    await f.close();
  }
});
test('validation rejects root traversal, unavailable capabilities, weak owner tokens', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    assert.throws(() =>
      f.hub.store.createProject({ deviceId: device.deviceId, name: 'bad', root: '/work/../etc' }),
    );
    assert.throws(() =>
      f.hub.store.createProject({ deviceId: device.deviceId, name: 'bad', root: '/workspace' }),
    );
    const p = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'valid',
      root: '/work',
    });
    assert.equal(
      (
        await f.request('/api/jobs', {
          projectId: p.id,
          idempotencyKey: 'browser-attempt',
          operation: { kind: 'browser.inspect', url: 'https://example.com' },
        })
      ).status,
      403,
    );
    await assert.rejects(createHub({ dataDir: f.dataDir, adminToken: 'short', port: 0 }));
  } finally {
    await f.close();
  }
});
test('dispatch and cancellation survive hub restart; pairing codes are one-time', async () => {
  const f = await fixture();
  try {
    const code = f.hub.store.createPairing().code;
    const enrollment = {
      pairingCode: code,
      name: 'Persistent',
      platform: 'linux',
      roots: ['/work'],
      allowShell: true,
      allowBrowser: false,
      version: '0.1.0',
    };
    const device = f.hub.store.enroll(enrollment);
    assert.throws(() => f.hub.store.enroll(enrollment), /pairing code/);
    const project = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Persistent',
      root: '/work',
    });
    const job = f.hub.store.createJob({
      projectId: project.id,
      idempotencyKey: 'restart-once',
      operation: { kind: 'command', command: 'true', timeoutMs: 1000 },
    });
    f.hub.store.poll(device.deviceId);
    f.hub.store.cancelJob(job.id);
    await f.hub.close();
    const reopened = await createHub({ dataDir: f.dataDir, adminToken, port: 0 });
    try {
      assert.equal(reopened.store.authenticateDevice(device.token), device.deviceId);
      const poll = reopened.store.poll(device.deviceId);
      assert.equal(poll.jobs[0]?.job.id, job.id);
      assert.equal(poll.jobs[0]?.job.status, 'dispatched');
      assert.deepEqual(poll.cancellations, [job.id]);
      reopened.store.updateJob(device.deviceId, { jobId: job.id, status: 'cancelled' });
      assert.equal(reopened.store.poll(device.deviceId).jobs.length, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});
test('log gaps, malformed chunks, payload caps and immutable terminal outcome', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    const project = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Logs',
      root: '/work',
    });
    const job = f.hub.store.createJob({
      projectId: project.id,
      idempotencyKey: 'log-boundaries',
      operation: { kind: 'command', command: 'true', timeoutMs: 1000 },
    });
    f.hub.store.poll(device.deviceId);
    const base = { jobId: job.id, status: 'running' as const };
    assert.throws(
      () => f.hub.store.updateJob(device.deviceId, { ...base, log: { offset: 100, data: 'YQ==' } }),
      /gap/,
    );
    assert.throws(
      () =>
        f.hub.store.updateJob(device.deviceId, { ...base, log: { offset: 0, data: '!invalid!' } }),
      /base64/,
    );
    assert.throws(() =>
      f.hub.store.updateJob(device.deviceId, {
        ...base,
        log: { offset: 0, data: Buffer.alloc(65537).toString('base64') },
      }),
    );
    assert.equal(f.hub.store.getJob(job.id)?.status, 'dispatched');
    f.hub.store.updateJob(device.deviceId, {
      ...base,
      log: { offset: 0, data: Buffer.from('abcdef').toString('base64') },
    });
    assert.deepEqual(f.hub.store.getLogs(job.id, 2, 2), {
      text: 'cd',
      nextOffset: 4,
      hasMore: true,
    });
    f.hub.store.updateJob(device.deviceId, {
      jobId: job.id,
      status: 'succeeded',
      result: { original: true },
      exitCode: 0,
    });
    f.hub.store.updateJob(device.deviceId, {
      jobId: job.id,
      status: 'succeeded',
      result: { replacement: true },
      exitCode: 22,
    });
    assert.deepEqual(f.hub.store.getJob(job.id)?.result, { original: true });
    assert.equal(f.hub.store.getJob(job.id)?.exitCode, 0);
    assert.throws(() => f.hub.store.getLogs(job.id, 7));
    assert.equal(
      (
        await f.request('/api/jobs', {
          projectId: project.id,
          idempotencyKey: 'oversized-content',
          operation: { kind: 'files.write', path: 'file', content: 'я'.repeat(600000) },
        })
      ).status,
      413,
    );
  } finally {
    await f.close();
  }
});
test('remote binding requires HTTPS and owner session cookies are secure', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'comand-remote-'));
  try {
    await assert.rejects(createHub({ dataDir, adminToken, host: '0.0.0.0' }), /HTTPS/);
    await assert.rejects(
      createHub({ dataDir, adminToken, publicUrl: 'http://example.com' }),
      /HTTPS/,
    );
    await assert.rejects(
      createHub({ dataDir, adminToken, publicUrl: 'https://example.com/prefix' }),
      /origin/,
    );
    const hub = await createHub({
      dataDir,
      adminToken,
      port: 0,
      publicUrl: 'https://comand.example',
    });
    try {
      await hub.start();
      // Exercise the app via a second ephemeral listener, preserving its external Origin.
      const server = hub.app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address() as {
          port: number;
        };
        const response = await fetch(`http://127.0.0.1:${address.port}/api/login`, {
          method: 'POST',
          headers: { origin: 'https://comand.example', 'content-type': 'application/json' },
          body: JSON.stringify({ token: adminToken }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('set-cookie')!, /; Secure/);
        assert.match(response.headers.get('set-cookie')!, /; HttpOnly/);
        assert.match(response.headers.get('set-cookie')!, /SameSite=Lax/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await hub.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('UTF-8 log reads retain byte offsets across both upload and read boundaries', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    const project = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Unicode',
      root: '/work',
    });
    const job = f.hub.store.createJob({
      projectId: project.id,
      idempotencyKey: 'unicode-log-test',
      operation: { kind: 'command', command: 'true', timeoutMs: 1000 },
    });
    f.hub.store.poll(device.deviceId);
    const text = 'Привет 👋 мир\n';
    const bytes = Buffer.from(text);
    // Stop the first upload inside the first Cyrillic character.
    f.hub.store.updateJob(device.deviceId, {
      jobId: job.id,
      status: 'running',
      log: { offset: 0, data: bytes.subarray(0, 1).toString('base64') },
    });
    assert.deepEqual(f.hub.store.getLogs(job.id), { text: '', nextOffset: 0, hasMore: false });
    f.hub.store.updateJob(device.deviceId, {
      jobId: job.id,
      status: 'running',
      log: { offset: 1, data: bytes.subarray(1).toString('base64') },
    });
    let offset = 0;
    let output = '';
    while (offset < bytes.length) {
      const chunk = f.hub.store.getLogs(job.id, offset, 1);
      assert.ok(chunk.nextOffset > offset);
      output += chunk.text;
      offset = chunk.nextOffset;
    }
    assert.equal(output, text);
    assert.equal(offset, bytes.length);
  } finally {
    await f.close();
  }
});

test('normalized duplicate roots are rejected and overlapping roots serialize dispatch', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    const parent = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Parent',
      root: '/work/project',
    });
    const duplicate = await f.request('/api/projects', {
      deviceId: device.deviceId,
      name: 'Alias',
      root: '/work//project/./',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(((await duplicate.json()) as { code: string }).code, 'duplicate_project_root');
    const child = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Child',
      root: '/work/project/sub',
    });
    const sibling = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Sibling',
      root: '/work/project-other',
    });
    const create = (projectId: string, key: string) =>
      f.hub.store.createJob({
        projectId,
        idempotencyKey: key,
        operation: { kind: 'command', command: 'true', timeoutMs: 1000 },
      });
    const parentJob = create(parent.id, 'overlap-parent');
    const childJob = create(child.id, 'overlap-child');
    const siblingJob = create(sibling.id, 'overlap-sibling');
    assert.deepEqual(
      f.hub.store.poll(device.deviceId).jobs.map((d) => d.job.id),
      [parentJob.id, siblingJob.id],
    );
    assert.equal(f.hub.store.getJob(childJob.id)?.status, 'queued');
    f.hub.store.updateJob(device.deviceId, { jobId: parentJob.id, status: 'uncertain' });
    f.hub.store.cancelJob(parentJob.id);
    assert.deepEqual(
      f.hub.store.poll(device.deviceId).jobs.map((d) => d.job.id),
      [siblingJob.id],
    );
    f.hub.store.updateJob(device.deviceId, {
      jobId: parentJob.id,
      status: 'failed',
      error: 'Owner reconciled the uncertain job',
    });
    assert.deepEqual(
      f.hub.store.poll(device.deviceId).jobs.map((d) => d.job.id),
      [childJob.id, siblingJob.id],
    );
    const secondParent = create(parent.id, 'overlap-parent-again');
    assert.ok(!f.hub.store.poll(device.deviceId).jobs.some((d) => d.job.id === secondParent.id));
    f.hub.store.updateJob(device.deviceId, { jobId: childJob.id, status: 'succeeded' });
    assert.ok(f.hub.store.poll(device.deviceId).jobs.some((d) => d.job.id === secondParent.id));
  } finally {
    await f.close();
  }
});

test('job lists omit result payloads while detail preserves the full result', async () => {
  const f = await fixture();
  try {
    const device = f.enroll();
    const project = f.hub.store.createProject({
      deviceId: device.deviceId,
      name: 'Large result',
      root: '/work/result',
    });
    const job = f.hub.store.createJob({
      projectId: project.id,
      idempotencyKey: 'large-result-summary',
      operation: { kind: 'command', command: 'true', timeoutMs: 1000 },
    });
    f.hub.store.poll(device.deviceId);
    const result = { screenshot: 'x'.repeat(1024 * 1024) };
    f.hub.store.updateJob(device.deviceId, { jobId: job.id, status: 'succeeded', result });
    const summary = f.hub.store.listJobs()[0]!;
    assert.equal(summary.result, null);
    assert.ok(JSON.stringify(summary).length < 1000);
    assert.deepEqual(f.hub.store.getJob(job.id)?.result, result);
    const overview = (await (await f.request('/api/overview')).json()) as {
      jobs: Array<{ result: unknown }>;
    };
    assert.equal(overview.jobs[0]?.result, null);
    const detail = (await (await f.request(`/api/jobs/${job.id}`)).json()) as { result: unknown };
    assert.deepEqual(detail.result, result);
  } finally {
    await f.close();
  }
});
