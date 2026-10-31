import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes, readlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import express from 'express';
import { installDistribution } from '../src/distribution.js';
// @ts-expect-error Build tooling is intentionally executable JavaScript.
import { deterministicArchive } from '../scripts/build-release.mjs';

const installer = path.resolve('scripts/install.sh');
async function command(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn('bash', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'comand-distribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  await mkdir(path.join(source, 'dist', 'agent'), { recursive: true });
  await mkdir(path.join(source, 'node_modules', 'runtime-dependency'), { recursive: true });
  await writeFile(path.join(source, 'node_modules', 'runtime-dependency', 'index.js'), 'export default 1;\n');
  await writeFile(path.join(source, 'package.json'), '{"type":"module","version":"0.2.0"}');
  await writeFile(path.join(source, 'release.json'), JSON.stringify({ name: 'comand-agent', version: '0.2.0', nodeMajor: 24, format: 1 }));
  await writeFile(path.join(source, 'dist', 'cli.js'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'version') console.log(JSON.parse(fs.readFileSync(new URL('../release.json', import.meta.url))).version);
else if (args[0] === 'service') {
  fs.appendFileSync(process.env.TEST_SERVICE_LOG, JSON.stringify(args) + '\\n');
  if (process.env.TEST_SERVICE_FAIL === '1') process.exit(1);
} else if (args[0] === 'agent' && args[1] === 'status') console.log('fixture status');
`);
  await writeFile(path.join(source, 'dist', 'agent', 'cli.js'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const config = { hubUrl: value('--url'), token: 'fixture-device-token', arguments: args };
fs.writeFileSync(path.join(value('--data-dir'), 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
`);
  const archivePath = path.join(directory, 'agent.tar.gz');
  await deterministicArchive(source, archivePath);
  let archive = await readFile(archivePath);
  let badChecksum = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/downloads/comand-agent.tar.gz') res.end(archive);
    else if (req.url === '/downloads/comand-agent.tar.gz.sha256')
      res.end(`${badChecksum ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex')}  comand-agent.tar.gz\n`);
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bin = path.join(directory, 'test-bin');
  await mkdir(bin);
  // The test runner may be root in CI. Only emulate the uid check; all other
  // commands, downloads, tar extraction and Node processes are real.
  await writeFile(path.join(bin, 'id'), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o700 });
  const hostile = " with spaces $(printf injected) `printf injected` & ' \"";
  const install = path.join(directory, 'program' + hostile);
  const data = path.join(directory, 'state' + hostile + ' \\');
  const root = path.join(directory, 'project' + hostile + ' \\');
  await mkdir(root);
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, TEST_SERVICE_LOG: path.join(directory, 'services.jsonl') };
  const base = ['--url', origin, '--install-dir', install, '--data-dir', data];
  return {
    directory, source, archivePath, requests, origin, install, data, root, env, base,
    setArchive: (value: Buffer) => archive = value,
    badChecksum: () => badChecksum = true,
    pair: () => ['--code', 'single-use-fixture-secret', '--name', 'device', '--root', root],
    rebuild: async () => { await deterministicArchive(source, archivePath); archive = await readFile(archivePath); },
  };
}

test('distribution serves only regular packaged files, reports absence, and does not expose directories', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'comand-download-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'install.sh'), '#!/bin/bash\n');
  await writeFile(path.join(dir, 'config.json'), 'private-fixture-token');
  await symlink(path.join(dir, 'config.json'), path.join(dir, 'comand-agent.tar.gz'));
  const app = express();
  installDistribution(app, { directory: dir });
  app.use((_req, res) => res.status(404).end());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const script = await fetch(`${url}/install.sh`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await script.text(), '#!/bin/bash\n');
  const head = await fetch(`${url}/install.sh`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const name of ['comand-agent.tar.gz', 'comand-agent.tar.gz.sha256']) {
    const response = await fetch(`${url}/downloads/${name}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'distribution_unavailable');
  }
  for (const target of ['/downloads/config.json', '/downloads/', '/downloads/%2e%2e/config.json', '/config.json']) {
    const response = await fetch(url + target);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes('private-fixture-token'));
  }
});

test('release tar is byte-reproducible, portable, contains runtime files and rejects links', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.archivePath);
  await utimes(path.join(f.source, 'dist', 'cli.js'), new Date(), new Date());
  await f.rebuild();
  assert.deepEqual(await readFile(f.archivePath), before);
  const listed = spawnSync('tar', ['-tzf', f.archivePath], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /comand-agent\/dist\/agent\/cli\.js/);
  assert.match(listed.stdout, /comand-agent\/node_modules\/runtime-dependency\/index\.js/);
  assert.ok(!/config\.json|admin\.token|\.sqlite/.test(listed.stdout));
  await symlink('/etc/passwd', path.join(f.source, 'unsafe-link'));
  await assert.rejects(f.rebuild(), /Unsupported archive entry/);
});

test('installer validates options, refuses remote HTTP and never traces the pairing code', async () => {
  assert.equal(spawnSync('bash', ['-n', installer]).status, 0);
  for (const args of [['--unknown'], ['--url'], ['--url', 'http://untrusted.example'], ['--url', 'https://user:pass@example.com'], ['--url', 'https://example.com/path']]) {
    const result = await command(['-x', installer, ...args, '--code', 'single-use-fixture-secret']);
    assert.notEqual(result.code, 0);
    assert.ok(!result.stderr.includes('single-use-fixture-secret'));
  }
  const help = await command([installer, '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--update/);
  const invalidPath = await command([installer, '--url', 'https://example.com', '--install-dir', '/tmp/path\\with-backslash']);
  assert.notEqual(invalidPath.code, 0);
  assert.match(invalidPath.stderr, /Node.js не поддерживает/);
});

test('installer pairs with literal arguments in paths with spaces, starts services and preserves identity on update', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const injected = path.join(f.directory, 'must-not-exist');
  const name = `Mac $(touch '${injected}') \`touch '${injected}'\``;
  const args = ['--code', 'single-use-fixture-secret', '--name', name, '--root', f.root, '--root', f.root, '--allow-shell', '--allow-browser'];
  const first = await command(['-x', installer, ...f.base, ...args], f.env);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert.ok(!first.stderr.includes('single-use-fixture-secret'));
  assert.ok(!first.stdout.includes('single-use-fixture-secret'));
  await assert.rejects(readFile(injected), /ENOENT/);
  const initial = await readFile(path.join(f.data, 'config.json'), 'utf8');
  const config = JSON.parse(initial);
  assert.equal(config.arguments[config.arguments.indexOf('--name') + 1], name);
  assert.equal(config.arguments.filter((value: string) => value === '--root').length, 2);
  assert.ok(config.arguments.includes('--allow-shell'));
  const calls = (await readFile(f.env.TEST_SERVICE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['service', 'install'], ['service', 'restart']]);
  const priorRequests = f.requests.length;
  const again = await command([installer, ...f.base, ...f.pair()], f.env);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /уже подключён/);
  assert.equal(f.requests.length, priorRequests, 'existing credentials are rejected before downloading');
  const updated = await command([installer, ...f.base, '--update'], f.env);
  assert.equal(updated.code, 0, updated.stderr + updated.stdout);
  assert.equal(await readFile(path.join(f.data, 'config.json'), 'utf8'), initial);
  const wrapper = spawnSync(path.join(f.install, 'bin', 'comand'), ['agent', 'status', '--data-dir', f.data], { encoding: 'utf8' });
  assert.equal(wrapper.status, 0, wrapper.stderr);
  assert.match(wrapper.stdout, /fixture status/);
  await unlink(path.join(f.install, '.comand-install'));
  await symlink(path.join(f.data, 'config.json'), path.join(f.install, '.comand-install'));
  const unsafeMarker = await command([installer, ...f.base, '--update'], f.env);
  assert.notEqual(unsafeMarker.code, 0);
  assert.match(unsafeMarker.stderr, /Некорректный маркер/);
  assert.equal(await readFile(path.join(f.data, 'config.json'), 'utf8'), initial);
});

test('checksum or traversal failure leaves credentials absent and does not publish a current release', { timeout: 30_000 }, async (t) => {
  for (const corrupt of ['checksum', 'traversal']) {
    const f = await fixture(t);
    if (corrupt === 'checksum') f.badChecksum();
    else {
      const tar = gunzipSync(await readFile(f.archivePath));
      const header = tar.subarray(0, 512);
      header.fill(0, 0, 100);
      header.write('comand-agent/../../escaped', 0);
      header.fill(32, 148, 156);
      const sum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
      f.setArchive(gzipSync(tar));
    }
    const result = await command([installer, ...f.base, ...f.pair(), '--no-service'], f.env);
    assert.notEqual(result.code, 0);
    await assert.rejects(readFile(path.join(f.data, 'config.json')), /ENOENT/);
    await assert.rejects(readlink(path.join(f.install, 'current')), /ENOENT/);
    await assert.rejects(readFile(path.join(f.directory, 'escaped')), /ENOENT/);
  }
});

test('failed update restores the prior release and retains credentials', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const first = await command([installer, ...f.base, ...f.pair()], f.env);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const prior = await readlink(path.join(f.install, 'current'));
  const credentials = await readFile(path.join(f.data, 'config.json'));
  await writeFile(path.join(f.source, 'release.json'), JSON.stringify({ name: 'comand-agent', version: '0.2.1', nodeMajor: 24, format: 1 }));
  await f.rebuild();
  const result = await command([installer, ...f.base, '--update'], { ...f.env, TEST_SERVICE_FAIL: '1' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /восстановлена предыдущая версия/);
  assert.equal(await readlink(path.join(f.install, 'current')), prior);
  assert.deepEqual(await readFile(path.join(f.data, 'config.json')), credentials);
});
