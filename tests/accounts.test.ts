import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub, type HubRuntime } from '../src/hub/server.js';
import { HubStore } from '../src/hub/store.js';
import { AccountsStore } from '../src/hub/accounts.js';
import { installMcp } from '../src/mcp/http.js';
import type {
  SessionInfo,
  AgentCredentials,
  Pairing,
  Project,
  Job,
} from '../src/shared/protocol.js';

const password = 'a strong unique test password';

test('project discovery is tenant isolated and cookie mutations require CSRF', async (t) => {
  const f = await fixture(t);
  const a = await f.register('discovery-a@example.com'),
    b = await f.register('discovery-b@example.com');
  const { credentials } = await f.enroll(a);
  assert.equal(
    (await f.request('/api/agent/poll', { projectDiscovery: true }, credentials.token)).status,
    200,
  );
  assert.equal(
    (
      await f.request('/api/discoveries', { deviceId: credentials.deviceId }, a, 'POST', {
        'X-Comand-CSRF': '',
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request('/api/discoveries', { deviceId: credentials.deviceId }, b)).status,
    404,
  );
  const response = await f.request('/api/discoveries', { deviceId: credentials.deviceId }, a);
  assert.equal(response.status, 202);
  const search = await response.json();
  assert.equal((await f.request(`/api/discoveries/${search.id}`, undefined, b)).status, 404);
  assert.equal(
    (
      await f.request(
        `/api/agent/discoveries/${search.id}/result`,
        {
          result: {
            roots: ['/work'],
            candidates: [{ root: '/work/site', name: 'site', markers: ['package.json'] }],
            visited: 2,
            truncated: false,
            warnings: [],
          },
        },
        credentials.token,
      )
    ).status,
    200,
  );
  const input = { discoveryId: search.id, root: '/work/site' };
  assert.equal((await f.request('/api/projects/open', input, b)).status, 404);
  assert.equal(
    (await f.request('/api/projects/open', input, a, 'POST', { 'X-Comand-CSRF': '' })).status,
    403,
  );
  assert.ok((await f.request('/api/projects/open', input, a)).ok);
  assert.equal((await (await f.request('/api/projects', undefined, b)).json()).length, 0);
});
type Login = SessionInfo & { recoveryCode?: string; cookie: string };
type Json = Record<string, unknown>;
async function fixture(t: test.TestContext, options: { registrationEnabled?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'comand-accounts-'));
  const adminToken = randomBytes(32).toString('base64url');
  let hub: HubRuntime;
  let mcp: ReturnType<typeof installMcp>;
  let url = '';
  async function start() {
    hub = await createHub({
      dataDir,
      adminToken,
      port: url ? Number(new URL(url).port) : 0,
      ...options,
    });
    url = await hub.start();
    mcp = installMcp(hub, { dataDir, publicUrl: url });
  }
  await start();
  t.after(async () => {
    mcp.close();
    await hub.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function request(
    path: string,
    body?: unknown,
    session?: Login | string,
    method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {},
  ) {
    return fetch(url + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        Origin: url,
        ...(typeof session === 'string'
          ? { Authorization: `Bearer ${session}` }
          : session
            ? { Cookie: session.cookie, 'X-Comand-CSRF': session.csrfToken! }
            : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function loginResponse(response: Response): Promise<Login> {
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return {
      ...((await response.json()) as SessionInfo),
      cookie: response.headers.get('set-cookie')!.split(';')[0]!,
    };
  }
  const register = async (email: string, name = email.split('@')[0]!) =>
    loginResponse(await request('/api/register', { name, email, password }));
  const login = async (email: string, pass = password) =>
    loginResponse(await request('/api/login', { email, password: pass }));
  async function enroll(session: Login | string) {
    const pair = (await (await request('/api/pairings', {}, session)).json()) as Pairing;
    const response = await request('/api/agent/enroll', {
      pairingCode: pair.code,
      name: 'Test computer',
      platform: 'linux',
      roots: ['/work'],
      allowShell: true,
      allowBrowser: false,
      version: '0.1.0',
    });
    assert.equal(response.status, 201);
    const credentials = (await response.json()) as AgentCredentials;
    return { credentials, pair };
  }
  async function oauth(session?: Login, credentials?: { email: string; password: string }) {
    const registered = (await (
      await request('/register', {
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'Account integration',
      })
    ).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: `${url}/mcp`,
      scope: 'comand:read comand:write comand:execute',
    });
    const authorize = await fetch(`${url}/authorize?${query}`, {
      redirect: 'manual',
      headers: { Connection: 'close' },
    });
    assert.equal(authorize.status, 303);
    const consentUrl = new URL(authorize.headers.get('location')!, url);
    const consent = await fetch(consentUrl, { headers: session ? { Cookie: session.cookie } : {} });
    const html = await consent.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const cookie = consent.headers.get('set-cookie')!.split(';')[0]!;
    const approval = await fetch(`${url}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Connection: 'close',
        Origin: url,
        Cookie: `${cookie}${session ? `; ${session.cookie}` : ''}`,
      },
      body: new URLSearchParams({
        request: consentUrl.searchParams.get('request')!,
        csrf,
        decision: 'allow',
        ...credentials,
      }),
    });
    assert.equal(approval.status, 303, await approval.clone().text());
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const exchange = async () =>
      fetch(`${url}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: registered.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: 'https://client.example/callback',
          resource: `${url}/mcp`,
        }),
      });
    return { exchange, registered };
  }
  async function mcpClient(token: string) {
    const client = new Client({ name: 'account-test', version: '1' });
    t.after(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: 'close' } },
      }),
    );
    return client;
  }
  return {
    get hub() {
      return hub;
    },
    get mcp() {
      return mcp;
    },
    get url() {
      return url;
    },
    dataDir,
    adminToken,
    request,
    register,
    login,
    loginResponse,
    enroll,
    oauth,
    mcpClient,
    async restart() {
      mcp.close();
      await hub.close();
      await start();
    },
  };
}

test('registration validates, normalizes unique email concurrently and stores no plaintext secrets', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/api/session')).json(), {
    authenticated: false,
    registrationEnabled: true,
  });
  for (const body of [
    { name: 'A', email: 'bad email', password },
    { name: 'A', email: 'a@example.com', password: 'too short' },
    { name: 'A', email: 'a@example.com', password: 'x'.repeat(129) },
    { name: '\n', email: 'a@example.com', password },
    { name: 'A', email: 'a@example.com', password, principal: 'owner' },
  ])
    assert.equal((await f.request('/api/register', body)).status, 400);
  assert.equal(
    (
      await f.request(
        '/api/register',
        { name: 'A', email: 'a@example.com', password },
        undefined,
        'POST',
        { Origin: 'https://attacker.example' },
      )
    ).status,
    403,
  );
  const results = await Promise.all(
    ['Alice@example.com', ' ALICE@example.com '].map((email) =>
      f.request('/api/register', { name: 'Alice', email, password }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const alice = await f.loginResponse(results.find((r) => r.status === 201)!);
  assert.equal(alice.user?.email, 'alice@example.com');
  assert.notEqual(alice.user?.id, 'owner');
  assert.ok(alice.recoveryCode);
  const bob = await f.register('bob@example.com');
  const db = new DatabaseSync(join(f.dataDir, 'accounts.sqlite'));
  try {
    const rows = db.prepare('SELECT * FROM accounts').all() as Json[];
    assert.equal(rows.length, 2);
    assert.notEqual(
      rows[0]!.password,
      rows[1]!.password,
      'Equal passwords must use different salts',
    );
    const data = JSON.stringify(rows) + JSON.stringify(db.prepare('SELECT * FROM sessions').all());
    for (const secret of [
      password,
      alice.recoveryCode!,
      bob.recoveryCode!,
      alice.cookie.split('=')[1]!,
    ])
      assert.ok(!data.includes(secret));
  } finally {
    db.close();
  }
  const sessionBody = (await (await f.request('/api/account', undefined, alice)).json()) as Json;
  assert.equal(sessionBody.recoveryCode, undefined);
  assert.deepEqual(sessionBody.user, alice.user);
  const wrong = await f.request('/api/login', {
    email: 'alice@example.com',
    password: 'wrong password',
  });
  const unknown = await f.request('/api/login', {
    email: 'unknown@example.com',
    password: 'wrong password',
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('persistent sessions enforce CSRF, rotate on login, logout and password changes', async (t) => {
  const f = await fixture(t);
  const a = await f.register('alice@example.com');
  const b = await f.login('alice@example.com');
  await f.restart();
  assert.deepEqual(
    ((await (await f.request('/api/session', undefined, a)).json()) as SessionInfo).user,
    a.user,
  );
  assert.equal(
    (await f.request('/api/pairings', {}, a, 'POST', { 'X-Comand-CSRF': '' })).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        '/api/account/password',
        { currentPassword: password, password: 'another strong password' },
        a,
        'POST',
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const changed = await f.loginResponse(
    await f.request(
      '/api/account/password',
      { currentPassword: password, password: 'another strong password' },
      a,
    ),
  );
  for (const previous of [a, b])
    assert.equal((await f.request('/api/devices', undefined, previous)).status, 401);
  assert.equal((await f.request('/api/devices', undefined, changed)).status, 200);
  assert.equal(
    (await f.request('/api/login', { email: 'alice@example.com', password })).status,
    401,
  );
  await f.login('alice@example.com', 'another strong password');
  assert.equal((await f.request('/api/logout', {}, changed)).status, 200);
  await f.restart();
  assert.equal((await f.request('/api/devices', undefined, changed)).status, 401);
});

test('REST resources, pairings and agent credential routes are structurally isolated across restart', async (t) => {
  const f = await fixture(t);
  const a = await f.register('alice@example.com');
  const b = await f.register('bob@example.com');
  const da = await f.enroll(a),
    db = await f.enroll(b);
  assert.equal(
    (
      await f.request('/api/agent/enroll', {
        pairingCode: da.pair.code,
        name: 'Replay',
        platform: 'linux',
        roots: ['/work'],
        allowShell: true,
        allowBrowser: false,
        version: '1',
      })
    ).status,
    401,
  );
  const project = (await (
    await f.request(
      '/api/projects',
      { deviceId: da.credentials.deviceId, name: 'Private A', root: '/work' },
      a,
    )
  ).json()) as Project;
  const created = await f.request(
    '/api/jobs',
    {
      projectId: project.id,
      idempotencyKey: 'private-a-job',
      operation: { kind: 'command', command: 'printf private' },
    },
    a,
  );
  assert.equal(created.status, 201);
  const job = (await created.json()) as Job;
  for (const [path, body, method] of [
    [`/api/devices/${da.credentials.deviceId}/revoke`, {}, 'POST'],
    [`/api/projects/${project.id}`, { notes: 'tamper' }, 'PATCH'],
    ['/api/projects', { deviceId: da.credentials.deviceId, name: 'Stolen', root: '/work' }, 'POST'],
    [
      '/api/jobs',
      {
        projectId: project.id,
        idempotencyKey: 'cross-user-intent',
        operation: { kind: 'command', command: 'id' },
      },
      'POST',
    ],
    [`/api/jobs/${job.id}`, undefined, 'GET'],
    [`/api/jobs/${job.id}/cancel`, {}, 'POST'],
    [`/api/jobs/${job.id}/logs`, undefined, 'GET'],
  ] as Array<[string, unknown, string]>)
    assert.equal((await f.request(path, body, b, method)).status, 404, path);
  for (const path of ['/api/devices', '/api/projects', '/api/jobs']) {
    const values = (await (await f.request(path, undefined, b)).json()) as Json[];
    assert.ok(!JSON.stringify(values).includes(da.credentials.deviceId));
    assert.ok(!JSON.stringify(values).includes(project.id));
  }
  await f.restart();
  assert.equal(
    (
      (await (await f.request('/api/agent/poll', {}, db.credentials.token)).json()) as {
        jobs: unknown[];
      }
    ).jobs.length,
    0,
  );
  const poll = (await (await f.request('/api/agent/poll', {}, da.credentials.token)).json()) as {
    jobs: Array<{ job: Job }>;
  };
  assert.equal(poll.jobs[0]?.job.id, job.id);
  assert.equal(
    (
      await f.request(
        `/api/agent/jobs/${job.id}/update`,
        { status: 'succeeded' },
        db.credentials.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        `/api/agent/jobs/${job.id}/update`,
        {
          status: 'succeeded',
          result: { secret: 'private A' },
          log: { offset: 0, data: Buffer.from('private A').toString('base64') },
        },
        da.credentials.token,
      )
    ).status,
    200,
  );
  assert.equal((await f.request(`/api/jobs/${job.id}/logs`, undefined, b)).status, 404);
  assert.equal((await f.request('/api/overview', undefined, f.adminToken)).status, 200);
  assert.deepEqual(
    (
      (await (await f.request('/api/overview', undefined, f.adminToken)).json()) as {
        devices: unknown[];
      }
    ).devices,
    [],
  );
});

test('MCP OAuth binds each principal through consent, token rotation, restart and cross-user probes', async (t) => {
  const f = await fixture(t);
  const a = await f.register('alice@example.com');
  const b = await f.register('bob@example.com');
  const device = await f.enroll(a);
  const project = (await (
    await f.request(
      '/api/projects',
      { deviceId: device.credentials.deviceId, name: 'A', root: '/work' },
      a,
    )
  ).json()) as Project;
  const grantA = await f.oauth(a),
    grantB = await f.oauth(undefined, { email: 'bob@example.com', password });
  const tokensA = (await (await grantA.exchange()).json()) as {
    access_token: string;
    refresh_token: string;
  };
  const tokensB = (await (await grantB.exchange()).json()) as {
    access_token: string;
    refresh_token: string;
  };
  const linksA = (await (await f.request('/api/connections', undefined, a)).json()) as {
    id: string;
  }[];
  const linksB = (await (await f.request('/api/connections', undefined, b)).json()) as {
    id: string;
  }[];
  assert.equal(linksA.length, 1);
  assert.equal(linksB.length, 1);
  assert.notEqual(linksA[0]!.id, linksB[0]!.id);
  assert.equal((await f.request(`/api/connections/${linksA[0]!.id}/revoke`, {}, b)).status, 404);
  assert.deepEqual(await (await f.request('/api/connections', undefined, f.adminToken)).json(), []);
  await f.restart();
  const oauthClient = await f.mcp.provider.clientsStore.getClient(grantA.registered.client_id);
  const refreshed = await f.mcp.provider.exchangeRefreshToken(oauthClient!, tokensA.refresh_token);
  assert.equal(
    (await f.mcp.provider.verifyAccessToken(refreshed.access_token)).extra?.principal,
    a.user!.id,
  );
  const ca = await f.mcpClient(refreshed.access_token),
    cb = await f.mcpClient(tokensB.access_token);
  const listedA = await ca.callTool({ name: 'list_devices', arguments: {} }),
    listedB = await cb.callTool({ name: 'list_devices', arguments: {} });
  assert.ok(JSON.stringify(listedA).includes(device.credentials.deviceId));
  assert.ok(!JSON.stringify(listedB).includes(device.credentials.deviceId));
  const made = await ca.callTool({
    name: 'run_command',
    arguments: { projectId: project.id, command: 'id', idempotencyKey: 'mcp-a-command' },
  });
  assert.notEqual(made.isError, true);
  const jobId = (made.structuredContent as { id: string }).id;
  for (const call of [
    { name: 'get_job', arguments: { jobId } },
    { name: 'get_job_logs', arguments: { jobId } },
    { name: 'cancel_job', arguments: { jobId } },
    { name: 'project_context', arguments: { projectId: project.id } },
    { name: 'save_project_notes', arguments: { projectId: project.id, notes: 'tampered' } },
    {
      name: 'create_project',
      arguments: { deviceId: device.credentials.deviceId, name: 'Stolen', root: '/work' },
    },
    {
      name: 'run_command',
      arguments: { projectId: project.id, command: 'id', idempotencyKey: 'mcp-b-command' },
    },
  ])
    assert.equal((await cb.callTool(call)).isError, true, call.name);
  const changed = await f.request(
    '/api/account/password',
    { currentPassword: password, password: 'new private password' },
    a,
  );
  assert.equal(changed.status, 200);
  await assert.rejects(f.mcp.provider.verifyAccessToken(refreshed.access_token));
  await assert.rejects(f.mcp.provider.exchangeRefreshToken(oauthClient!, refreshed.refresh_token!));
  await f.mcp.provider.verifyAccessToken(tokensB.access_token);
});

test('one-time recovery rotates its code and revokes sessions, pending codes and grants only for that account', async (t) => {
  const f = await fixture(t);
  const a = await f.register('alice@example.com'),
    b = await f.register('bob@example.com');
  const pendingA = await f.oauth(a),
    connectedA = await f.oauth(a),
    connectedB = await f.oauth(b);
  const tokensA = (await (await connectedA.exchange()).json()) as { access_token: string };
  const tokensB = (await (await connectedB.exchange()).json()) as { access_token: string };
  const wrong = await f.request('/api/recover', {
    email: 'alice@example.com',
    recoveryCode: 'wrong',
    password,
  });
  const absent = await f.request('/api/recover', {
    email: 'unknown@example.com',
    recoveryCode: 'wrong',
    password,
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), await absent.json());
  const results = await Promise.all(
    [1, 2].map(() =>
      f.request('/api/recover', {
        email: 'alice@example.com',
        recoveryCode: a.recoveryCode,
        password: 'recovered private password',
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const recovered = await f.loginResponse(results.find((r) => r.status === 200)!);
  assert.notEqual(recovered.recoveryCode, a.recoveryCode);
  assert.equal((await f.request('/api/devices', undefined, a)).status, 401);
  assert.equal((await f.request('/api/devices', undefined, b)).status, 200);
  assert.equal((await pendingA.exchange()).status, 400);
  await assert.rejects(f.mcp.provider.verifyAccessToken(tokensA.access_token));
  await f.mcp.provider.verifyAccessToken(tokensB.access_token);
  await f.restart();
  assert.equal((await f.request('/api/devices', undefined, recovered)).status, 200);
  assert.equal(
    (await f.request('/api/login', { email: 'alice@example.com', password })).status,
    401,
  );
  await f.login('alice@example.com', 'recovered private password');
});

test('explicit owner claim preserves old workspace, devices, pairings and owner-key fallback', async (t) => {
  const f = await fixture(t);
  const old = f.hub.store.enroll({
    pairingCode: f.hub.store.createPairing().code,
    name: 'Legacy',
    platform: 'linux',
    roots: ['/work'],
    allowShell: true,
    allowBrowser: false,
    version: '0.1.0',
  });
  const pairing = f.hub.store.createPairing();
  const owner = await f.loginResponse(await f.request('/api/login', { token: f.adminToken }));
  const fresh = await f.register('new@example.com');
  assert.equal(
    (
      await f.request(
        '/api/account/claim',
        { name: 'Stolen', email: 'stolen@example.com', password },
        fresh,
      )
    ).status,
    403,
  );
  assert.deepEqual(await (await f.request('/api/devices', undefined, fresh)).json(), []);
  assert.equal((await f.request('/api/agent/poll', {}, old.token)).status, 200);
  const claimed = await f.loginResponse(
    await f.request(
      '/api/account/claim',
      { name: 'Owner', email: 'owner@example.com', password },
      owner,
    ),
  );
  assert.equal(claimed.user?.id, 'owner');
  assert.ok(claimed.recoveryCode);
  assert.equal(
    (
      await f.request(
        '/api/account/claim',
        { name: 'Second', email: 'second@example.com', password },
        claimed,
      )
    ).status,
    409,
  );
  await f.restart();
  const passwordLogin = await f.login('owner@example.com');
  const devices = (await (await f.request('/api/devices', undefined, passwordLogin)).json()) as {
    id: string;
  }[];
  assert.equal(devices[0]?.id, old.deviceId);
  assert.equal((await f.request('/api/agent/poll', {}, old.token)).status, 200);
  assert.equal(
    (
      await f.request('/api/agent/enroll', {
        pairingCode: pairing.code,
        name: 'Old pending pairing',
        platform: 'linux',
        roots: ['/work'],
        allowShell: false,
        allowBrowser: false,
        version: '0.1.0',
      })
    ).status,
    201,
  );
  await f.loginResponse(await f.request('/api/login', { token: f.adminToken }));
  assert.throws(
    () => new HubStore(f.dataDir, randomBytes(32).toString('base64url')),
    /different owner key/,
  );
  assert.equal((await f.request('/api/devices', undefined, f.adminToken)).status, 200);
});

test('registration can be disabled and account throttling spans clients and OAuth credential entry', async (t) => {
  const disabled = await fixture(t, { registrationEnabled: false });
  assert.equal(
    (await disabled.request('/api/register', { name: 'A', email: 'a@example.com', password }))
      .status,
    403,
  );
  assert.equal(
    ((await (await disabled.request('/api/session')).json()) as SessionInfo).registrationEnabled,
    false,
  );
  const f = await fixture(t);
  await f.register('alice@example.com');
  for (let i = 0; i < 12; i++) {
    const principal = await f.hub.auth.authenticateCredentials({
      email: 'alice@example.com',
      password: 'incorrect password',
    });
    assert.equal(principal, undefined);
  }
  const blocked = await f.request(
    '/api/login',
    { email: 'alice@example.com', password },
    undefined,
    'POST',
    { 'X-Forwarded-For': '203.0.113.42' },
  );
  assert.equal(blocked.status, 429);
  await f.register('bob@example.com');
});

test('credential version invalidates sessions and OAuth even when recovery crashes before grant revocation', async (t) => {
  const f = await fixture(t);
  const a = await f.register('alice@example.com');
  const authorized = await f.oauth(a),
    pending = await f.oauth(a);
  const tokens = (await (await authorized.exchange()).json()) as {
    access_token: string;
    refresh_token: string;
  };
  // Simulate the durable account write followed by process loss before the OAuth callback.
  const accounts = new AccountsStore(f.dataDir);
  try {
    await accounts.recover({
      email: 'alice@example.com',
      recoveryCode: a.recoveryCode,
      password: 'changed after crash',
    });
  } finally {
    accounts.close();
  }
  await f.restart();
  assert.equal((await f.request('/api/devices', undefined, a)).status, 401);
  assert.equal((await pending.exchange()).status, 400);
  await assert.rejects(f.mcp.provider.verifyAccessToken(tokens.access_token));
  const client = await f.mcp.provider.clientsStore.getClient(authorized.registered.client_id);
  await assert.rejects(f.mcp.provider.exchangeRefreshToken(client!, tokens.refresh_token));
  const recovered = await f.login('alice@example.com', 'changed after crash');
  assert.equal((await f.request('/api/devices', undefined, recovered)).status, 200);
});

test('historical OAuth grants and codes migrate to owner and cannot enter a newly registered account', async (t) => {
  const f = await fixture(t);
  const owner = await f.loginResponse(await f.request('/api/login', { token: f.adminToken }));
  const approved = await f.oauth(owner),
    pending = await f.oauth(owner);
  const tokens = (await (await approved.exchange()).json()) as {
    access_token: string;
    refresh_token: string;
  };
  f.mcp.close();
  // Materialize the preceding release's exact schema without principal/version columns.
  const db = new DatabaseSync(join(f.dataDir, 'oauth.sqlite'));
  try {
    db.exec('DROP INDEX oauth_grants_principal');
    for (const table of ['oauth_grants', 'oauth_codes']) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN principal`);
      db.exec(`ALTER TABLE ${table} DROP COLUMN credential_version`);
    }
  } finally {
    db.close();
  }
  await f.restart();
  const newAccount = await f.register('new@example.com');
  assert.deepEqual(await (await f.request('/api/connections', undefined, newAccount)).json(), []);
  const oldAccess = await f.mcp.provider.verifyAccessToken(tokens.access_token);
  assert.equal(oldAccess.extra?.principal, 'owner');
  const codeExchange = await pending.exchange();
  assert.equal(codeExchange.status, 200);
  const codeTokens = (await codeExchange.json()) as { access_token: string };
  assert.equal(
    (await f.mcp.provider.verifyAccessToken(codeTokens.access_token)).extra?.principal,
    'owner',
  );
  const client = await f.mcp.provider.clientsStore.getClient(approved.registered.client_id);
  const refreshed = await f.mcp.provider.exchangeRefreshToken(client!, tokens.refresh_token);
  assert.equal(
    (await f.mcp.provider.verifyAccessToken(refreshed.access_token)).extra?.principal,
    'owner',
  );
  assert.equal(
    ((await (await f.request('/api/connections', undefined, f.adminToken)).json()) as unknown[])
      .length,
    2,
  );
});

test('process stdin is absent from job summaries and overview while dispatch and detail retain it', async (t) => {
  const f = await fixture(t);
  const account = await f.register('stdin@example.com');
  const { credentials } = await f.enroll(account);
  const project = (await (
    await f.request(
      '/api/projects',
      { deviceId: credentials.deviceId, name: 'Terminal', root: '/work' },
      account,
    )
  ).json()) as Project;
  const input = {
    projectId: project.id,
    idempotencyKey: 'stdin-summary-redaction',
    operation: {
      kind: 'process.input',
      sessionId: `ps_${'a'.repeat(64)}`,
      input: 'PRIVATE_TERMINAL_CREDENTIAL\n',
      closeStdin: false,
    },
  };
  const job = (await (await f.request('/api/jobs', input, account)).json()) as Job;
  for (const path of ['/api/jobs', '/api/overview']) {
    const response = await f.request(path, undefined, account);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('PRIVATE_TERMINAL_CREDENTIAL'), path);
  }
  const store = f.hub.storeFor(account.user!.id);
  assert.equal(store.listJobs()[0]?.operation.kind, 'process.input');
  assert.deepEqual(store.listJobs()[0]?.operation, { ...input.operation, input: '' });
  assert.deepEqual(store.getJob(job.id)?.operation, input.operation);
  const polled = (await (await f.request('/api/agent/poll', {}, credentials.token)).json()) as {
    jobs: Array<{ job: Job }>;
  };
  assert.deepEqual(
    polled.jobs[0]?.job.operation,
    input.operation,
    'Execution must receive the original stdin',
  );
  assert.equal(
    (
      await f.request(
        `/api/agent/jobs/${job.id}/update`,
        { status: 'succeeded', result: { text: 'PRIVATE_TERMINAL_RESULT' } },
        credentials.token,
      )
    ).status,
    200,
  );
  const summaries = JSON.stringify(store.listJobs());
  assert.ok(!summaries.includes('PRIVATE_TERMINAL_'));
  const detail = (await (await f.request(`/api/jobs/${job.id}`, undefined, account)).json()) as Job;
  assert.deepEqual(detail.operation, input.operation);
  assert.deepEqual(detail.result, { text: 'PRIVATE_TERMINAL_RESULT' });
  const replay = await f.request('/api/jobs', input, account);
  assert.equal(replay.status, 200);
  assert.equal(
    ((await replay.json()) as Job).id,
    job.id,
    'Summary redaction must not alter the deduplicated job',
  );
});

test('version heartbeats refresh only the authenticated device, validate before mutation and preserve legacy polling', async (t) => {
  const { VERSION } = await import('../src/shared/protocol.js');
  const { pollOnce } = await import('../src/agent/index.js');
  const f = await fixture(t);
  const account = await f.register('heartbeat@example.com');
  const otherAccount = await f.register('other-heartbeat@example.com');
  const { credentials: device } = await f.enroll(account);
  const { credentials: sibling } = await f.enroll(account);
  const { credentials: foreign } = await f.enroll(otherAccount);
  const deviceState = () => f.hub.storeFor(account.user!.id).getDevice(device.deviceId)!;
  assert.equal(deviceState().version, '0.1.0');
  assert.equal((await f.request('/api/agent/poll', {}, device.token)).status, 200);
  assert.equal(
    deviceState().version,
    '0.1.0',
    'An old agent heartbeat must retain its recorded version',
  );
  assert.ok(deviceState().lastSeenAt);

  await pollOnce({
    hubUrl: f.url,
    ...device,
    name: 'Heartbeat',
    roots: ['/work'],
    allowShell: true,
    allowBrowser: false,
    dataDir: join(f.dataDir, 'heartbeat-agent'),
    pollMs: 1000,
    maxConcurrent: 1,
  });
  assert.equal(deviceState().version, VERSION, 'The real agent must report its running version');
  assert.equal((await f.request('/api/agent/poll', {}, device.token)).status, 200);
  assert.equal(deviceState().version, VERSION, 'Omitted version must not erase the last report');
  const snapshot = deviceState();
  for (const body of [
    { version: 42 },
    { version: null },
    { version: {} },
    { version: [] },
    { version: '' },
    { version: '   ' },
    { version: 'x'.repeat(101) },
    { version: '0.2\n.0' },
    [],
  ]) {
    assert.equal((await f.request('/api/agent/poll', body, device.token)).status, 400);
    assert.deepEqual(
      deviceState(),
      snapshot,
      'Invalid reports must not update heartbeat or version',
    );
  }
  for (const deviceId of [sibling.deviceId, foreign.deviceId]) {
    assert.equal(
      (await f.request('/api/agent/poll', { deviceId, version: '9.9.9' }, device.token)).status,
      400,
    );
  }
  assert.equal(f.hub.storeFor(account.user!.id).getDevice(sibling.deviceId)?.version, '0.1.0');
  assert.equal(f.hub.storeFor(otherAccount.user!.id).getDevice(foreign.deviceId)?.version, '0.1.0');
  assert.equal(
    (await f.request('/api/agent/poll', { version: '9.9.9' }, 'invalid-device-token')).status,
    401,
  );
  assert.deepEqual(deviceState(), snapshot);
  await f.restart();
  assert.equal(deviceState().version, VERSION, 'Version must survive hub restart');
  assert.equal(
    (await f.request(`/api/devices/${device.deviceId}/revoke`, {}, account)).status,
    200,
  );
  assert.equal(
    (await f.request('/api/agent/poll', { version: '9.9.9' }, device.token)).status,
    401,
  );
  assert.equal(deviceState().version, VERSION, 'Revoked credentials cannot update device metadata');
});

test('pairing status follows the exact enrolled device through heartbeat and restart without exposing secrets', async (t) => {
  const f = await fixture(t);
  const a = await f.register('pairing-a@example.com'),
    b = await f.register('pairing-b@example.com');
  const create = async (session: Login) =>
    (await (await f.request('/api/pairings', {}, session)).json()) as Pairing;
  const first = await create(a),
    second = await create(a),
    other = await create(b);
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.id, first.code);
  assert.notEqual(first.id, second.id);
  assert.match(first.installationProfile!, /^[a-f0-9]{64}$/);
  assert.equal(first.installationProfile, second.installationProfile);
  assert.notEqual(first.installationProfile, other.installationProfile);
  const status = (pair: Pairing, session = a) =>
    f.request(`/api/pairings/${pair.id}`, undefined, session);
  assert.deepEqual(await (await status(first)).json(), {
    expiresAt: first.expiresAt,
    device: null,
  });
  assert.equal((await f.request(`/api/pairings/${first.id}`)).status, 401);
  assert.equal((await status(first, b)).status, 404);
  assert.equal((await status(other, a)).status, 404);
  assert.equal((await f.request(`/api/pairings/${first.code}`, undefined, a)).status, 404);
  const enrollment = {
    name: 'Automatic computer',
    platform: 'linux',
    roots: ['/work'],
    allowShell: true,
    allowBrowser: false,
    version: '0.2.0',
  };
  for (const pairingCode of [first.id, 'a-valid-length-wrong-code']) {
    assert.equal(
      (await f.request('/api/agent/enroll', { ...enrollment, pairingCode })).status,
      401,
    );
    assert.deepEqual(await (await status(first)).json(), {
      expiresAt: first.expiresAt,
      device: null,
    });
  }
  const attempts = await Promise.all(
    [1, 2].map(() => f.request('/api/agent/enroll', { ...enrollment, pairingCode: second.code })),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 401]);
  const device = (await attempts.find((r) => r.status === 201)!.json()) as AgentCredentials;
  const enrolled = (await (
    await status(second)
  ).json()) as import('../src/shared/protocol.js').PairingStatus;
  assert.equal(enrolled.device?.id, device.deviceId);
  assert.equal(enrolled.device?.online, false, 'Enrollment alone is not a running agent');
  assert.equal(enrolled.expiresAt, second.expiresAt);
  assert.deepEqual(Object.keys(enrolled).sort(), ['device', 'expiresAt']);
  for (const secret of [second.code, device.token, 'token_hash', 'code_hash'])
    assert.ok(!JSON.stringify(enrolled).includes(secret));
  assert.deepEqual(
    await (await status(first)).json(),
    { expiresAt: first.expiresAt, device: null },
    'Another installation must not complete this pairing',
  );
  assert.equal((await f.request('/api/agent/poll', {}, device.token)).status, 200);
  assert.equal(
    ((await (await status(second)).json()) as import('../src/shared/protocol.js').PairingStatus)
      .device?.online,
    true,
  );
  await f.restart();
  const restored = (await (
    await status(second)
  ).json()) as import('../src/shared/protocol.js').PairingStatus;
  assert.equal(restored.device?.id, device.deviceId);
  assert.equal(restored.device?.online, true);
  assert.deepEqual(await (await status(first)).json(), {
    expiresAt: first.expiresAt,
    device: null,
  });
  assert.equal(
    (await f.request('/api/agent/enroll', { ...enrollment, pairingCode: second.code })).status,
    401,
  );
  assert.equal((await f.request(`/api/devices/${device.deviceId}/revoke`, {}, a)).status, 200);
  assert.equal(
    ((await (await status(second)).json()) as import('../src/shared/protocol.js').PairingStatus)
      .device?.online,
    false,
  );
});

test('pairing receipts expire after retention, preserve old codes and commit atomically with enrollment', async (t) => {
  const f = await fixture(t);
  const pair = f.hub.store.createPairing();
  const enrollment = {
    pairingCode: pair.code,
    name: 'Receipt transaction',
    platform: 'linux' as const,
    roots: ['/work'],
    allowShell: false,
    allowBrowser: false,
    version: '0.2.0',
  };
  const db = new DatabaseSync(join(f.dataDir, 'hub.sqlite'));
  try {
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE ON pairing_status BEGIN SELECT RAISE(ABORT, 'simulated receipt write failure'); END;",
    );
    assert.throws(() => f.hub.store.enroll(enrollment), /simulated receipt write failure/);
    assert.deepEqual(
      f.hub.store.listDevices(),
      [],
      'A failed receipt update must roll back device creation',
    );
    assert.deepEqual(f.hub.store.getPairingStatus(pair.id), {
      expiresAt: pair.expiresAt,
      device: null,
    });
    db.exec('DROP TRIGGER reject_receipt');
    const device = f.hub.store.enroll(enrollment);
    assert.equal(
      f.hub.store.getPairingStatus(pair.id).device?.id,
      device.deviceId,
      'Failed enrollment must leave the code usable',
    );
    assert.throws(() => f.hub.store.enroll(enrollment), /Invalid or expired pairing code/);

    const expired = f.hub.store.createPairing();
    const expiry = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE pairings SET expires_at=? WHERE code_hash=?').run(
      expiry,
      createHash('sha256').update(expired.code).digest('hex'),
    );
    db.prepare('UPDATE pairing_status SET expires_at=? WHERE id=?').run(expiry, expired.id);
    const expiredStatus = await f.request(`/api/pairings/${expired.id}`, undefined, f.adminToken);
    assert.equal(expiredStatus.status, 200);
    assert.deepEqual(await expiredStatus.json(), { expiresAt: expiry, device: null });
    assert.equal(
      (await f.request('/api/agent/enroll', { ...enrollment, pairingCode: expired.code })).status,
      401,
    );
    const retentionPast = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE pairing_status SET expires_at=? WHERE id=?').run(retentionPast, expired.id);
    assert.equal(
      (await f.request(`/api/pairings/${expired.id}`, undefined, f.adminToken)).status,
      404,
    );
    f.hub.store.createPairing();
    assert.equal(
      db.prepare('SELECT id FROM pairing_status WHERE id=?').get(expired.id),
      undefined,
      'Issuing a new pairing cleans old receipts',
    );

    // A pre-upgrade two-column pairing has no receipt but remains enrollable.
    const oldCode = randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO pairings(code_hash,expires_at) VALUES(?,?)').run(
      createHash('sha256').update(oldCode).digest('hex'),
      new Date(Date.now() + 60_000).toISOString(),
    );
    assert.equal(
      (await f.request('/api/agent/enroll', { ...enrollment, pairingCode: oldCode })).status,
      201,
    );
    assert.equal(
      (await f.request('/api/agent/enroll', { ...enrollment, pairingCode: oldCode })).status,
      401,
    );
  } finally {
    db.close();
  }
});
