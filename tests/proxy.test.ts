import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/hub/server.js';
import { installMcp } from '../src/mcp/http.js';

const adminToken = 'proxy-test-owner-token-with-more-than-32-characters';

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'comand-proxy-'));
  const hub = await createHub({ dataDir, adminToken, port: 0 });
  const url = await hub.start();
  const mcp = installMcp(hub, { dataDir, publicUrl: url });
  t.after(async () => {
    await hub.close();
    mcp.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const status = async (route: string, forwardedFor: string, body: unknown = {}) => {
    const response = await fetch(url + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url,
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
  return { hub, url, status };
}

test('only the direct loopback proxy can establish client IP, and extra hops cannot spoof it', async (t) => {
  const { hub, url } = await fixture(t);
  const trust = hub.app.get('trust proxy fn') as (address: string, hop: number) => boolean;
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(trust(address, 0), true);
    assert.equal(trust(address, 1), false);
  }
  for (const address of ['198.51.100.12', '2001:db8::12', '10.0.0.12', '::ffff:198.51.100.12']) {
    assert.equal(trust(address, 0), false);
  }
  // This extension route exists only in the fixture and observes Express's real IP resolution.
  hub.app.get('/api/connections/ip-proof', (req, res) => res.json({ ip: req.ip }));
  const response = await fetch(url + '/api/connections/ip-proof', {
    headers: { 'x-forwarded-for': '198.51.100.99, 127.0.0.1, 203.0.113.12' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ip: '203.0.113.12' });
});

test('a proxied client cannot exhaust another client login or pairing limit', async (t) => {
  const { status } = await fixture(t);
  for (let i = 0; i < 30; i++) {
    // Varying an untrusted earlier hop must not evade the actual client limit.
    assert.equal(await status('/api/login', `198.51.100.${i + 1}, 203.0.113.20`), 401);
  }
  assert.equal(await status('/api/login', '198.51.100.200, 203.0.113.20'), 429);
  assert.equal(await status('/api/login', '203.0.113.21', { token: adminToken }), 200);
  assert.equal(await status('/api/agent/enroll', '203.0.113.21'), 400);
});

test('OAuth consent and SDK registration limits distinguish clients behind the local proxy', async (t) => {
  const { status } = await fixture(t);
  for (let i = 0; i < 20; i++) {
    assert.equal(await status('/oauth/consent', '203.0.113.30'), 403);
    assert.equal(await status('/register', '203.0.113.30'), 400);
  }
  assert.equal(await status('/oauth/consent', '203.0.113.30'), 429);
  assert.equal(await status('/register', '203.0.113.30'), 429);
  assert.equal(await status('/oauth/consent', '203.0.113.31'), 403);
  assert.equal(
    await status('/register', '203.0.113.31', {
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
    201,
  );
});
