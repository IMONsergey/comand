import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

test('service status shows lifecycle information without inherited environment or journal data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'comand-service-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const argsPath = join(dir, 'arguments.json');
  const darwin = process.platform === 'darwin';
  const manager = darwin ? 'launchctl' : 'systemctl';
  const output = darwin
    ? 'service = {\n\tstate = running\n\tpid = 12345\n\truns = 1\n\tlast exit code = (never exited)\n\tinherited environment = {\n\t\tAPI_TOKEN => private-test-credential\n\t}\n}\n'
    : 'ActiveState=active\nSubState=running\nMainPID=12345\nExecMainStatus=0\nNRestarts=1\nEnvironment=API_TOKEN=private-test-credential\nJournal: private-test-credential\n';
  await writeFile(
    join(dir, manager),
    `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(output)}); });\n`,
    { mode: 0o700 },
  );
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'service', 'status', '--data-dir', dir],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}` },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /running/);
  assert.match(child.stdout, /12345/);
  assert.ok(!child.stdout.includes('private-test-credential'));
  assert.ok(!child.stdout.includes('API_TOKEN'));
  if (!darwin) {
    const args = JSON.parse(await readFile(argsPath, 'utf8')) as string[];
    assert.ok(args.includes('show'));
    assert.ok(!args.includes('status'), 'systemctl status includes unbounded journal data');
  }
});
