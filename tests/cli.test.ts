import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { serviceDefinition } from '../src/service.js';
import { VERSION } from '../src/shared/protocol.js';

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('COMAND_')) delete env[key];
  return env;
};

test('both CLI executables run when invoked through npm-style symlinks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'comand-cli-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [source, args, expected] of [
    ['src/cli.ts', ['version'], new RegExp(`^${VERSION.replaceAll('.', '\\.')}\\s*$`)],
    ['src/agent/cli.ts', [], /Usage: comand-agent pair/],
  ] as const) {
    const link = join(dir, source.includes('agent') ? 'comand-agent' : 'comand');
    await symlink(resolve(source), link);
    const child = spawnSync(process.execPath, ['--import', 'tsx', link, ...args], {
      encoding: 'utf8',
      env: cleanEnv(),
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, expected);
  }
});

test('init saves explicit environment configuration for future service starts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'comand-cli-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'init', '--data-dir', dir],
    {
      encoding: 'utf8',
      env: {
        ...cleanEnv(),
        COMAND_HOST: '127.0.0.1',
        COMAND_PORT: '4321',
        COMAND_PUBLIC_URL: 'https://comand.example',
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'hub.json'), 'utf8')), {
    host: '127.0.0.1',
    port: 4321,
    publicUrl: 'https://comand.example',
  });
});

test(
  'a successful public hub launch preserves its settings for later service startup',
  { timeout: 15_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'comand-cli-hub-'));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'hub',
        '--data-dir',
        dir,
        '--port',
        '0',
        '--public-url',
        'https://comand.example',
      ],
      {
        env: cleanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise<void>((done, reject) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('listening at')) done();
      });
      child.once('exit', () => reject(Error(`Hub exited before startup: ${stderr}`)));
      child.once('error', reject);
    });
    const config = JSON.parse(await readFile(join(dir, 'hub.json'), 'utf8'));
    assert.equal(config.publicUrl, 'https://comand.example');
    assert.equal(config.port, 0);
  },
);

test('agent service definitions retain an explicitly selected browser channel', () => {
  const previous = process.env.COMAND_BROWSER_CHANNEL;
  process.env.COMAND_BROWSER_CHANNEL = 'chrome';
  try {
    const linux = serviceDefinition('agent', '/tmp/comand-service-agent', 'linux');
    const variables = Object.fromEntries(
      linux.content
        .split('\n')
        .filter((line) => line.startsWith('Environment='))
        .map((line) => {
          const raw = line.slice('Environment='.length);
          const value: string = raw.startsWith('"') ? JSON.parse(raw) : raw;
          const split = value.indexOf('=');
          return [value.slice(0, split), value.slice(split + 1)];
        }),
    );
    const linuxChild = spawnSync(process.execPath, ['-p', 'process.env.COMAND_BROWSER_CHANNEL'], {
      env: { ...cleanEnv(), ...variables },
      encoding: 'utf8',
    });
    assert.equal(linuxChild.stdout.trim(), 'chrome');
    const mac = serviceDefinition('agent', '/tmp/comand-service-agent', 'darwin');
    assert.match(mac.content, /<key>COMAND_BROWSER_CHANNEL<\/key><string>chrome<\/string>/);
  } finally {
    if (previous === undefined) delete process.env.COMAND_BROWSER_CHANNEL;
    else process.env.COMAND_BROWSER_CHANNEL = previous;
  }
});
