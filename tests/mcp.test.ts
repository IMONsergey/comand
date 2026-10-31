import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HubStore } from '../src/hub/store.js';
import { createMcpServer } from '../src/mcp/tools.js';
import type { Job, Operation } from '../src/shared/protocol.js';
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

test('get_job emits browser JPEG as image without duplicating base64 in metadata', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'comand-mcp-image-'));
  const store = new HubStore(dataDir, randomBytes(32).toString('base64url'));
  const client = new Client({ name: 'image-result-test', version: '1' });
  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const device = store.enroll({
    pairingCode: store.createPairing().code,
    name: 'Browser fixture',
    platform: 'linux',
    roots: [dataDir],
    allowShell: false,
    allowBrowser: true,
    version: '0.1.0',
  });
  const project = store.createProject({
    deviceId: device.deviceId,
    name: 'Screenshot',
    root: dataDir,
  });
  function finish(operation: Operation, value: unknown): Job {
    const job = store.createJob({
      projectId: project.id,
      operation,
      idempotencyKey: randomBytes(16).toString('hex'),
    });
    store.poll(device.deviceId);
    store.updateJob(device.deviceId, { jobId: job.id, status: 'succeeded', result: value });
    return store.getJob(job.id)!;
  }
  // A real one-pixel JPEG, encoded once as image content only.
  const screenshot =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iiiigD//2Q==';
  const operation: Operation = {
    kind: 'browser.inspect',
    url: 'https://example.com',
    width: 1440,
    height: 1000,
    screenshot: true,
  };
  const metadata = {
    url: 'https://example.com',
    title: 'Example',
    text: 'Visible page text',
    screenshotMime: 'image/jpeg',
  };
  const job = finish(operation, { ...metadata, screenshot });
  const response = await client.callTool({ name: 'get_job', arguments: { jobId: job.id } });
  assert.notEqual(response.isError, true);
  assert.ok(Array.isArray(response.content));
  const images = response.content.filter((block) => block.type === 'image');
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { type: 'image', mimeType: 'image/jpeg', data: screenshot });
  const expected = { ...job, result: metadata };
  assert.deepEqual(response.structuredContent, expected);
  const text = response.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.deepEqual(JSON.parse(text.text), expected);
  assert.ok(!text.text.includes(screenshot));
  assert.deepEqual(store.getJob(job.id), job, 'MCP formatting must not alter persisted results');

  for (const [candidateOperation, candidateResult] of [
    [
      { kind: 'files.read', path: 'page.json', offset: 0, limit: 65536 },
      { content: screenshot, screenshot, screenshotMime: 'image/jpeg' },
    ],
    [operation, { ...metadata, screenshot: 'invalid base64!' }],
    [operation, { ...metadata, screenshot: Buffer.from('not a JPEG').toString('base64') }],
    [operation, { ...metadata, screenshot, screenshotMime: 'text/html' }],
  ] as Array<[Operation, unknown]>) {
    const original = finish(candidateOperation, candidateResult);
    const unchanged = await client.callTool({ name: 'get_job', arguments: { jobId: original.id } });
    assert.ok(Array.isArray(unchanged.content));
    assert.equal(unchanged.content.filter((block) => block.type === 'image').length, 0);
    assert.deepEqual(unchanged.structuredContent, original);
    const originalText = unchanged.content.find((block) => block.type === 'text');
    assert.ok(originalText && originalText.type === 'text');
    assert.deepEqual(JSON.parse(originalText.text), original);
  }
});

test('MCP process mutations require intent keys and read grants cannot execute or retrieve process payloads', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'comand-mcp-process-'));
  const store = new HubStore(dataDir, randomBytes(32).toString('base64url'));
  const device = store.enroll({
    pairingCode: store.createPairing().code,
    name: 'Process device',
    platform: 'linux',
    roots: [dataDir],
    allowShell: true,
    allowBrowser: false,
    version: '0.1.0',
  });
  const project = store.createProject({
    deviceId: device.deviceId,
    name: 'Process',
    root: dataDir,
  });
  const sessionId = `ps_${'a'.repeat(64)}`;
  const input = store.createJob({
    projectId: project.id,
    operation: {
      kind: 'process.input',
      sessionId,
      input: 'PRIVATE_STDIN_SENTINEL',
      closeStdin: false,
    },
    idempotencyKey: 'private-process-input',
  });
  store.poll(device.deviceId);
  store.updateJob(device.deviceId, {
    jobId: input.id,
    status: 'succeeded',
    result: { text: 'PRIVATE_OUTPUT_SENTINEL' },
  });
  const clients: Client[] = [],
    servers: ReturnType<typeof createMcpServer>[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const connect = async (scopes: string[]) => {
    const client = new Client({ name: 'process-scope-test', version: '1' }),
      server = createMcpServer(store, scopes);
    clients.push(client);
    servers.push(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  const reader = await connect(['comand:read']);
  for (const [name, args] of [
    ['start_process', { projectId: project.id, command: 'id', idempotencyKey: 'forbidden-start' }],
    [
      'interact_with_process',
      { projectId: project.id, sessionId, input: 'id\n', idempotencyKey: 'forbidden-input' },
    ],
    ['read_process_output', { projectId: project.id, sessionId }],
    ['list_sessions', { projectId: project.id }],
    ['force_terminate', { projectId: project.id, sessionId, idempotencyKey: 'forbidden-stop' }],
    ['get_job', { jobId: input.id }],
    ['get_job_logs', { jobId: input.id }],
  ] as Array<[string, Record<string, unknown>]>) {
    const response = await reader.callTool({ name, arguments: args });
    assert.equal(response.isError, true, name);
    assert.match(JSON.stringify(response), /comand:execute/);
    assert.ok(!JSON.stringify(response).includes('PRIVATE_'));
  }
  for (const [name, args] of [
    ['list_jobs', {}],
    ['project_context', { projectId: project.id }],
  ] as Array<[string, Record<string, unknown>]>) {
    const response = await reader.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true);
    assert.ok(!JSON.stringify(response).includes('PRIVATE_'), name);
  }
  const executor = await connect(['comand:read', 'comand:execute']);
  const tools = (await executor.listTools()).tools;
  for (const name of ['start_process', 'interact_with_process', 'force_terminate']) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.ok(tool.inputSchema.required?.includes('projectId'));
    assert.ok(tool.inputSchema.required?.includes('idempotencyKey'));
  }
  const args = {
    projectId: project.id,
    command: 'cat',
    idempotencyKey: 'deduplicated-start-process',
  };
  const first = await executor.callTool({ name: 'start_process', arguments: args });
  const replay = await executor.callTool({ name: 'start_process', arguments: args });
  assert.equal(first.isError, undefined);
  assert.equal((first.structuredContent as Job).id, (replay.structuredContent as Job).id);
  assert.equal((first.structuredContent as Job).operation.kind, 'process.start');
  assert.equal(
    (
      await executor.callTool({
        name: 'start_process',
        arguments: { ...args, command: 'different' },
      })
    ).isError,
    true,
  );
});
