import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('hub snapshot restores every account database, rejects corruption and unsafe copies', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util, tempfile, pathlib, sqlite3, os, json, hashlib, types
spec=importlib.util.spec_from_file_location('backup','scripts/backup-hub.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp); state=root/'state'; state.mkdir()
 (state/'manifest.json').write_text('metadata from a previous restore')
 for name in ['hub.json','admin.token','oauth.key']: (state/name).write_text('private-fixture')
 for name in ['hub.sqlite','accounts.sqlite','oauth.sqlite','accounts/user/hub.sqlite']:
  p=state/name; p.parent.mkdir(parents=True,exist_ok=True)
  c=sqlite3.connect(p); c.execute('create table proof(value text)'); c.execute('insert into proof values (?)',('retained',)); c.commit(); c.close()
 wal=sqlite3.connect(state/'hub.sqlite'); wal.execute('PRAGMA journal_mode=WAL'); wal.execute("update proof set value='from-wal'"); wal.commit()
 result=m.snapshot(state,root/'snapshots',offline=True)
 wal.close()
 assert result['databases']==4
 copied=pathlib.Path(result['snapshot'])
 for p in copied.rglob('*.sqlite'):
  c=sqlite3.connect(p); assert c.execute('select value from proof').fetchone()==(('from-wal' if p.name=='hub.sqlite' and p.parent==copied else 'retained'),); c.close()
 assert (copied/'admin.token').stat().st_mode & 0o777 == 0o600
 (copied/'admin.token').write_text('changed')
 try: m.verify(copied); raise AssertionError('corruption accepted')
 except ValueError: pass
 try: m.snapshot(state,state/'nested',offline=True); raise AssertionError('recursive backup accepted')
 except ValueError: pass
 (state/'bad-link').symlink_to(root)
 try: m.snapshot(state,root/'snapshots',offline=True); raise AssertionError('link accepted')
 except ValueError: pass
 calls=[]
 def manager(args, **kwargs):
  calls.append(args[2])
  return types.SimpleNamespace(stdout=('inactive' if 'stop' in calls and 'start' not in calls else 'active')+'\\n')
 m.subprocess.run=manager
 service='comand-hub-'+hashlib.sha256(str(state).encode()).hexdigest()[:8]+'.service'
 try: m.snapshot(state,root/'snapshots',service=service); raise AssertionError('link accepted')
 except ValueError: pass
 assert 'stop' in calls and 'start' in calls, calls
 assert not list((root/'snapshots').glob('.partial-*'))
 assert (state/'admin.token').read_text()=='private-fixture'
print('snapshot restore, corruption, paths and cleanup passed')
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verified backup boots an isolated hub with account and OAuth state', async () => {
  const build = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHub } = await import('../src/hub/server.js');
  const { installMcp } = await import('../src/mcp/http.js');
  const directory = await mkdtemp(join(tmpdir(), 'comand-backup-test-'));
  const state = join(directory, 'hub');
  const { writeFile } = await import('node:fs/promises');
  const token = (await import('node:crypto')).randomBytes(32).toString('base64url');
  const hub = await createHub({ dataDir: state, adminToken: token, port: 0 });
  let mcp: ReturnType<typeof installMcp> | undefined;
  try {
    const url = await hub.start();
    mcp = installMcp(hub, { dataDir: state, publicUrl: url });
    await writeFile(join(state, 'admin.token'), token);
    await writeFile(join(state, 'hub.json'), '{}');
    const response = await fetch(url + '/api/register', {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Restore fixture',
        email: 'restore@example.test',
        password: 'restore-fixture-password',
      }),
    });
    assert.equal(response.status, 201);
    const account = await response.json();
    hub.storeFor(account.user.id);
    mcp.close();
    mcp = undefined;
    await hub.close();
    const backup = spawnSync(
      'python3',
      [
        'scripts/backup-hub.py',
        '--state',
        state,
        '--destination',
        join(directory, 'backups'),
        '--offline',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(backup.status, 0, backup.stderr);
    const snapshot = JSON.parse(backup.stdout).snapshot;
    const drill = spawnSync(process.execPath, ['scripts/restore-drill.mjs', snapshot], {
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(drill.status, 0, drill.stderr);
    assert.deepEqual(JSON.parse(drill.stdout), {
      ok: true,
      accounts: 1,
      devices: 0,
      projects: 0,
      jobs: 0,
      oauthLoaded: true,
      isolatedLoopback: true,
    });
  } finally {
    mcp?.close();
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  }
});
