import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { createHub } from '../src/hub/server.js';
import { allowAllFiles, allowRoot, loadConfig, pairDevice, pollOnce } from '../src/agent/index.js';
import { executeFileOperation, projectRoot } from '../src/agent/files.js';
import { prepareProject } from '../src/mcp/prepare-project.js';
import { discoverProjects } from '../src/agent/discovery.js';

async function temporary(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'comand-discovery-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('project discovery reads directory metadata without creating workspaces, following symlinks or scanning dependency trees', async (t) => {
  const base = await temporary(t),
    root = path.join(base, 'Projects');
  const project = path.join(root, 'Сайт клиента');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'package.json'), 'PRIVATE CONTENT MUST NOT LEAVE DEVICE');
  await mkdir(path.join(root, 'node_modules', 'dependency'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'dependency', 'package.json'), '{}');
  await mkdir(path.join(root, '.secrets'), { recursive: true });
  await writeFile(path.join(root, '.secrets', 'README.md'), 'private');
  await mkdir(path.join(base, 'outside'));
  await writeFile(path.join(base, 'outside', 'package.json'), '{}');
  await symlink(path.join(base, 'outside'), path.join(root, 'external'));
  const before = await readdir(root);
  const result = await discoverProjects({ query: 'сайт' }, [root]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.root, project);
  assert.deepEqual(result.candidates[0]!.markers, ['package.json']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE CONTENT'));
  assert.deepEqual(await readdir(root), before);
  assert.equal(
    await readFile(path.join(project, 'package.json'), 'utf8'),
    'PRIVATE CONTENT MUST NOT LEAVE DEVICE',
  );
  assert.equal((await discoverProjects({ query: '' }, [root])).candidates.length, 1);
  await assert.rejects(
    discoverProjects({ query: '', path: path.join(root, 'external') }, [root]),
    /области/,
  );
  await assert.rejects(discoverProjects({ query: '', path: base }, [root]), /области/);
  await mkdir(path.join(root, 'deep', 'a', 'b', 'c', 'd', 'e'), { recursive: true });
  assert.equal((await discoverProjects({ query: '' }, [root])).truncated, true);
  const missing = await discoverProjects({ query: 'missing' }, [path.join(base, 'not-there')]);
  assert.equal(missing.warnings.length, 1);
});

test('device discovery works before any project, survives restart, is isolated and reopens the same existing root', async (t) => {
  const base = await temporary(t),
    root = path.join(base, 'Projects'),
    project = path.join(root, 'existing');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'pyproject.toml'), '[project]');
  const token = randomBytes(32).toString('base64url'),
    state = path.join(base, 'hub');
  let hub = await createHub({ dataDir: state, adminToken: token, port: 0 });
  const url = await hub.start();
  t.after(async () => hub.close());
  const config = await pairDevice({
    url,
    code: hub.store.createPairing().code,
    name: 'device',
    roots: [root],
    dataDir: path.join(base, 'agent'),
    allowShell: false,
  });
  await pollOnce(config);
  const request = (route: string, body?: unknown, credential = token) =>
    fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal(
    (await request('/api/discoveries', { deviceId: config.deviceId }, 'invalid')).status,
    401,
  );
  const response = await request('/api/discoveries', {
    deviceId: config.deviceId,
    query: 'existing',
  });
  assert.equal(response.status, 202);
  const search = await response.json();
  assert.equal(hub.store.listProjects().length, 0);
  assert.equal(
    hub.store.createDiscovery({ deviceId: config.deviceId, query: 'existing' }).id,
    search.id,
  );
  assert.throws(
    () => hub.store.createDiscovery({ deviceId: config.deviceId, query: 'other' }),
    /уже идёт/,
  );
  await hub.close();
  hub = await createHub({ dataDir: state, adminToken: token, port: Number(new URL(url).port) });
  await hub.start();
  await pollOnce(config);
  const result = await (await request(`/api/discoveries/${search.id}`)).json();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.candidates[0].root, project);
  assert.equal(hub.store.listProjects().length, 0);
  assert.equal(
    (await request('/api/projects/open', { discoveryId: search.id, root: root })).status,
    400,
  );
  const opened = await (
    await request('/api/projects/open', { discoveryId: search.id, root: project })
  ).json();
  const reopened = await (
    await request('/api/projects/open', { discoveryId: search.id, root: project })
  ).json();
  assert.equal(reopened.id, opened.id);
  assert.equal(hub.store.listProjects().length, 1);
  assert.equal(await readFile(path.join(project, 'pyproject.toml'), 'utf8'), '[project]');
  const second = hub.store.enroll({
    pairingCode: hub.store.createPairing().code,
    name: 'other device',
    platform: 'linux',
    roots: [root],
    allowShell: false,
    allowBrowser: false,
    version: '0.2.2',
  });
  assert.throws(() => hub.store.createDiscovery({ deviceId: second.deviceId }), /Обновите агент/);
  assert.equal(
    (await request(`/api/agent/discoveries/${search.id}/result`, { error: 'forged' }, second.token))
      .status,
    403,
  );
  const pending = hub.store.createDiscovery({ deviceId: config.deviceId, query: 'pending' });
  assert.throws(
    () =>
      hub.store.completeDiscovery(config.deviceId, pending.id, {
        result: { ...result.result, candidates: [{ root: '/outside', name: 'bad', markers: [] }] },
      }),
    /разрешённые/,
  );
  const db = new DatabaseSync(path.join(state, 'hub.sqlite'));
  db.prepare("UPDATE discoveries SET data=json_set(data,'$.expiresAt',?) WHERE id=?").run(
    '2000-01-01T00:00:00.000Z',
    pending.id,
  );
  db.close();
  assert.equal(hub.store.getDiscovery(pending.id).status, 'expired');
  assert.equal(hub.store.poll(config.deviceId, { projectDiscovery: true }).discoveries!.length, 0);
  hub.store.revokeDevice(config.deviceId);
  assert.throws(
    () => hub.store.openDiscoveredProject({ discoveryId: search.id, root: project }),
    /revoked/i,
  );
});

test('MCP exposes discovery without a project and read-only scope cannot register a discovered folder', async (t) => {
  const base = await temporary(t),
    token = randomBytes(32).toString('base64url');
  const hub = await createHub({ dataDir: base, adminToken: token, port: 0 });
  const device = hub.store.enroll({
    pairingCode: hub.store.createPairing().code,
    name: 'MCP device',
    platform: 'linux',
    roots: ['/projects'],
    allowShell: false,
    allowBrowser: false,
    version: '0.3.0',
  });
  hub.store.poll(device.deviceId, { projectDiscovery: true });
  const server = createMcpServer(hub.store, ['comand:read']);
  const client = new Client({ name: 'discovery-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    await hub.close();
  });
  const started = await client.callTool({
    name: 'find_projects',
    arguments: { deviceId: device.deviceId, query: 'site' },
  });
  assert.equal(started.isError, undefined);
  const id = started.structuredContent!.id as string;
  hub.store.completeDiscovery(device.deviceId, id, {
    result: {
      roots: ['/projects'],
      candidates: [{ root: '/projects/site', name: 'site', markers: ['package.json'] }],
      visited: 2,
      truncated: false,
      warnings: [],
    },
  });
  const read = await client.callTool({ name: 'get_project_search', arguments: { searchId: id } });
  assert.equal(read.structuredContent!.status, 'succeeded');
  const denied = await client.callTool({
    name: 'open_project',
    arguments: { discoveryId: id, root: '/projects/site' },
  });
  assert.equal(denied.isError, true);
  assert.equal(hub.store.listProjects().length, 0);
  assert.match(client.getInstructions()!, /Never initialize, clone/);
});

test('adding an existing local root preserves device identity and rejects credential directories', async (t) => {
  const base = await temporary(t),
    state = path.join(base, 'agent'),
    original = path.join(base, 'workspace'),
    extra = path.join(base, 'Projects');
  await Promise.all([mkdir(state), mkdir(original), mkdir(extra)]);
  const config = {
    hubUrl: 'http://127.0.0.1:4310',
    deviceId: 'same-device',
    token: randomBytes(32).toString('hex'),
    roots: [original],
    dataDir: state,
    allowShell: true,
    allowBrowser: false,
  };
  await writeFile(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await allowRoot(state, extra), [original, extra]);
  assert.deepEqual(await allowRoot(state, extra), [original, extra]);
  assert.deepEqual(await loadConfig(state), { ...config, roots: [original, extra] });
  for (const forbidden of [state, base, '/', 'relative'])
    await assert.rejects(allowRoot(state, forbidden));
  await assert.rejects(allowRoot(state, path.join(base, 'missing')));
  await writeFile(path.join(state, 'configuration.lock'), 'held');
  await assert.rejects(allowRoot(state, extra), /EEXIST/);
  assert.deepEqual(await loadConfig(state), { ...config, roots: [original, extra] });
});

test('explicit full-access migration preserves credentials and permits existing folders outside prior roots', async (t) => {
  const base = await temporary(t),
    state = path.join(base, 'agent'),
    original = path.join(base, 'limited'),
    other = path.join(base, 'other');
  await Promise.all([mkdir(state), mkdir(original), mkdir(other)]);
  const config = {
    hubUrl: 'http://127.0.0.1:4310',
    deviceId: 'unchanged',
    token: randomBytes(32).toString('hex'),
    roots: [original],
    dataDir: state,
    allowShell: true,
    allowBrowser: false,
  };
  await writeFile(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(path.join(other, 'README.md'), 'existing work');
  await assert.rejects(projectRoot(other, config.roots), /outside approved/);
  assert.deepEqual(await allowAllFiles(state), ['/']);
  assert.deepEqual(await loadConfig(state), { ...config, roots: ['/'] });
  const result = (await executeFileOperation(
    { kind: 'files.read', path: 'README.md', offset: 0, limit: 1024 },
    other,
    ['/'],
  )) as { content: string };
  assert.equal(result.content, 'existing work');
  const search = await discoverProjects({ query: 'other', path: base }, ['/']);
  assert.equal(search.candidates[0]!.root, other);
  await writeFile(path.join(state, 'configuration.lock'), 'held');
  await assert.rejects(allowAllFiles(state), /EEXIST/);
  assert.deepEqual(await loadConfig(state), { ...config, roots: ['/'] });
});

test('MCP prepares an existing project end to end without dashboard setup or filesystem creation', async (t) => {
  const base = await temporary(t),
    root = path.join(base, 'Projects'),
    project = path.join(root, 'customer-site');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'package.json'), '{"name":"customer-site"}');
  const hub = await createHub({
    dataDir: path.join(base, 'hub'),
    adminToken: randomBytes(32).toString('hex'),
    port: 0,
  });
  const url = await hub.start();
  const config = await pairDevice({
    url,
    code: hub.store.createPairing().code,
    name: 'work computer',
    roots: [root],
    dataDir: path.join(base, 'agent'),
  });
  await pollOnce(config);
  const server = createMcpServer(hub.store),
    client = new Client({ name: 'prepare-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    await hub.close();
  });
  const first = await client.callTool({
    name: 'prepare_project',
    arguments: { query: 'customer-site' },
  });
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent!.status, 'searching');
  assert.equal(hub.store.listProjects().length, 0);
  const searchIds = first.structuredContent!.searchIds as string[];
  const pending = await client.callTool({
    name: 'prepare_project',
    arguments: { query: 'customer-site', searchIds },
  });
  assert.equal(pending.structuredContent!.status, 'searching');
  await pollOnce(config);
  const prepared = await client.callTool({
    name: 'prepare_project',
    arguments: { query: 'customer-site', searchIds },
  });
  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent!.status, 'ready');
  const record = prepared.structuredContent!.project as { id: string; root: string };
  assert.equal(record.root, project);
  const again = await prepareProject(hub.store, { query: 'customer-site' });
  assert.equal(again.status, 'ready');
  assert.equal('project' in again && again.project!.id, record.id);
  assert.equal(hub.store.listProjects().length, 1);
  assert.deepEqual(await readdir(root), ['customer-site']);
  assert.deepEqual(await readdir(project), ['package.json']);
  assert.equal(hub.store.listJobs().length, 0);
  const wrong = await client.callTool({
    name: 'prepare_project',
    arguments: { query: 'other', searchIds },
  });
  assert.equal(wrong.isError, true);
  // Similar registered copies must be investigated by the agent, not chosen arbitrarily.
  hub.store.createProject({
    deviceId: config.deviceId,
    name: 'customer-site old',
    root: path.join(root, 'old'),
  });
  assert.equal(
    (await prepareProject(hub.store, { query: 'customer-site' })).status,
    'inspect_candidates',
  );
  assert.equal((await prepareProject(hub.store, { projectId: record.id })).status, 'ready');
});

test('project preparation does not mistake an incomplete search or offline device for absence', async (t) => {
  const base = await temporary(t);
  const hub = await createHub({
    dataDir: base,
    adminToken: randomBytes(32).toString('hex'),
    port: 0,
  });
  t.after(() => hub.close());
  const device = hub.store.enroll({
    pairingCode: hub.store.createPairing().code,
    name: 'device',
    platform: 'linux',
    roots: ['/'],
    allowShell: true,
    allowBrowser: false,
    version: '0.4.0',
  });
  hub.store.poll(device.deviceId, { projectDiscovery: true });
  const first = await prepareProject(hub.store, { query: 'site' });
  assert.equal(first.status, 'searching');
  const searchIds = 'searchIds' in first ? first.searchIds! : [];
  hub.store.completeDiscovery(device.deviceId, searchIds[0]!, {
    result: { roots: ['/home/user'], candidates: [], visited: 3, truncated: true, warnings: [] },
  });
  assert.equal(
    (await prepareProject(hub.store, { query: 'site', searchIds })).status,
    'incomplete',
  );
  assert.equal(hub.store.listProjects().length, 0);
  const server = createMcpServer(hub.store, ['comand:read']),
    client = new Client({ name: 'read-only-prepare', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const denied = await client.callTool({ name: 'prepare_project', arguments: { query: 'site' } });
  assert.equal(denied.isError, true);
  assert.equal(hub.store.listProjects().length, 0);
});
