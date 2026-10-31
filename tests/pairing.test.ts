import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.js';
import { pairDevice, validateHubUrl } from '../src/agent/index.js';

test('concurrent pairing consumes one code and preserves one device identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'comand-pair-race-'));
  const hub = await createHub({
    dataDir: join(dir, 'hub'),
    adminToken: randomBytes(32).toString('base64url'),
    port: 0,
  });
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = await hub.start();
  const root = join(dir, 'workspace');
  await mkdir(root);
  const codes = [hub.store.createPairing().code, hub.store.createPairing().code];
  const results = await Promise.allSettled(
    codes.map((code) =>
      pairDevice({ url, code, name: 'Mac', roots: [root], dataDir: join(dir, 'agent') }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(hub.store.listDevices().length, 1);
  const config = JSON.parse(await readFile(join(dir, 'agent', 'config.json'), 'utf8'));
  assert.equal(config.deviceId, hub.store.listDevices()[0]!.id);
  await assert.rejects(
    pairDevice({ url, code: codes[1]!, name: 'Other', roots: [root], dataDir: join(dir, 'agent') }),
    /already paired/,
  );
  assert.equal(hub.store.listDevices().length, 1);
});

test('failed pairing releases its lock for correction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'comand-pair-fail-'));
  const hub = await createHub({
    dataDir: join(dir, 'hub'),
    adminToken: randomBytes(32).toString('base64url'),
    port: 0,
  });
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = await hub.start();
  const root = join(dir, 'workspace');
  await mkdir(root);
  const options = { url, name: 'Mac', roots: [root], dataDir: join(dir, 'agent') };
  await assert.rejects(pairDevice({ ...options, code: 'nonexistent-code' }));
  const config = await pairDevice({ ...options, code: hub.store.createPairing().code });
  assert.ok(config.deviceId);
});

test('agent hub addresses cannot contain path prefixes or credentials', () => {
  for (const value of [
    'https://example.com/prefix',
    'https://user:secret@example.com',
    'http://example.com',
  ])
    assert.throws(() => validateHubUrl(value));
  assert.equal(validateHubUrl('https://example.com/'), 'https://example.com');
});
