import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub } from '../src/hub/server.js';
import { installMcp } from '../src/mcp/http.js';

test('MCP requires bearer auth and exposes valid metadata, tools and durable command IDs', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'comand-mcp-'));
  const token = randomBytes(32).toString('base64url');
  const hub = await createHub({ dataDir, adminToken: token, port: 0 });
  const url = await hub.start();
  const mcp = installMcp(hub, { dataDir, publicUrl: url });
  const client = new Client({ name: 'comand-test', version: '1' });
  t.after(async () => {
    await client.close();
    mcp.close();
    await hub.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const unauth = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate')!, /resource_metadata/);
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const confused = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Authorization: 'Bearer not-an-owner-token',
    },
    body: '{}',
  });
  assert.equal(confused.status, 401, 'A browser session must not upgrade an invalid MCP bearer');
  const meta = (await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json()) as {
    resource: string;
  };
  assert.equal(meta.resource, `${url}/mcp`);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'run_command'));
  assert.ok(listed.tools.some((tool) => tool.name === 'read_file'));
  const pairing = hub.store.createPairing();
  const device = hub.store.enroll({
    pairingCode: pairing.code,
    name: 'Test Mac',
    platform: 'darwin',
    roots: [dataDir],
    allowShell: true,
    allowBrowser: false,
    version: '0.1.0',
  });
  const project = hub.store.createProject({
    deviceId: device.deviceId,
    name: 'Fixture',
    root: dataDir,
  });
  const first = await client.callTool({
    name: 'run_command',
    arguments: {
      projectId: project.id,
      command: 'printf comand',
      idempotencyKey: 'same-command-intent',
    },
  });
  assert.equal(first.isError, undefined);
  const firstData = first.structuredContent as { id: string; status: string };
  assert.equal(firstData.status, 'queued');
  const second = await client.callTool({
    name: 'run_command',
    arguments: {
      projectId: project.id,
      command: 'printf comand',
      idempotencyKey: 'same-command-intent',
    },
  });
  assert.equal((second.structuredContent as { id: string }).id, firstData.id);
  const conflict = await client.callTool({
    name: 'run_command',
    arguments: {
      projectId: project.id,
      command: 'printf different',
      idempotencyKey: 'same-command-intent',
    },
  });
  assert.equal(conflict.isError, true);
});

test('OAuth HTTP consent, PKCE token exchange and read-only MCP scope work together', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'comand-oauth-http-'));
  const token = randomBytes(32).toString('base64url');
  const hub = await createHub({ dataDir, adminToken: token, port: 0 });
  const url = await hub.start();
  const mcp = installMcp(hub, { dataDir, publicUrl: url });
  const client = new Client({ name: 'scoped-client', version: '1' });
  t.after(async () => {
    await client.close();
    mcp.close();
    await hub.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const registeredResponse = await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Read only test',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registeredResponse.status, 201);
  const registered = (await registeredResponse.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'comand:read',
    resource: `${url}/mcp`,
    state: 'flow-state',
  });
  const authorization = await fetch(`${url}/authorize?${query}`, { redirect: 'manual' });
  assert.equal(authorization.status, 303);
  const consentUrl = new URL(authorization.headers.get('location')!, url);
  const consent = await fetch(consentUrl);
  const html = await consent.text();
  const cookie = consent.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const request = consentUrl.searchParams.get('request')!;
  const body = new URLSearchParams({ request, csrf, token, decision: 'allow' });
  const rejected = await fetch(`${url}/oauth/consent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
      Origin: 'https://evil.example',
    },
    body,
    redirect: 'manual',
  });
  assert.equal(rejected.status, 403);
  const allowed = await fetch(`${url}/oauth/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: url },
    body,
    redirect: 'manual',
  });
  assert.equal(allowed.status, 303);
  const target = new URL(allowed.headers.get('location')!);
  assert.equal(target.origin, 'https://client.example');
  assert.equal(target.searchParams.get('state'), 'flow-state');
  const tokenResponse = await fetch(`${url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registered.client_id,
      code: target.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: 'https://client.example/callback',
      resource: `${url}/mcp`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const access = (await tokenResponse.json()) as { access_token: string };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${access.access_token}` } },
    }),
  );
  assert.notEqual((await client.callTool({ name: 'list_devices', arguments: {} })).isError, true);
  assert.equal(
    (
      await client.callTool({
        name: 'run_command',
        arguments: { projectId: 'none', command: 'id', idempotencyKey: 'forbidden-operation' },
      })
    ).isError,
    true,
  );
  const connections = (await (
    await fetch(`${url}/api/connections`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  assert.equal(connections.length, 1);
  assert.equal(
    (
      await fetch(`${url}/api/connections/${connections[0]!.id}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    200,
  );
  await assert.rejects(client.callTool({ name: 'list_devices', arguments: {} }));
});
