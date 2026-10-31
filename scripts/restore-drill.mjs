#!/usr/bin/env node
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../dist/hub/server.js';
import { installMcp } from '../dist/mcp/http.js';
import { fileURLToPath } from 'node:url';
const snapshot = process.argv[2];
if (!snapshot) throw Error('Usage: node scripts/restore-drill.mjs /absolute/snapshot');
const verification = spawnSync(
  'python3',
  [fileURLToPath(new URL('./backup-hub.py', import.meta.url)), '--verify', snapshot],
  { encoding: 'utf8' },
);
if (verification.status !== 0) throw Error('Backup verification failed; no hub started');
const directory = await mkdtemp(path.join(tmpdir(), 'comand-restore-drill-'));
let hub, mcp;
try {
  const dataDir = path.join(directory, 'hub');
  await cp(snapshot, dataDir, { recursive: true });
  const token = (await readFile(path.join(dataDir, 'admin.token'), 'utf8')).trim();
  const config = JSON.parse(await readFile(path.join(dataDir, 'hub.json'), 'utf8'));
  hub = await createHub({
    dataDir,
    adminToken: token,
    host: '127.0.0.1',
    port: 0,
    webDir: path.join(directory, 'no-web'),
  });
  const url = await hub.start();
  mcp = installMcp(hub, { dataDir, publicUrl: config.publicUrl ?? url });
  const db = new DatabaseSync(path.join(dataDir, 'accounts.sqlite'), { readOnly: true });
  let ids;
  try {
    ids = db
      .prepare('SELECT id FROM accounts')
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
  let devices = 0,
    projects = 0,
    jobs = 0;
  for (const id of new Set(['owner', ...ids])) {
    const store = hub.storeFor(id);
    devices += store.listDevices().length;
    projects += store.listProjects().length;
    jobs += store.listJobs().length;
  }
  const health = await fetch(url + '/health');
  if (!health.ok) throw Error('Restored hub did not become healthy');
  console.log(
    JSON.stringify({
      ok: true,
      accounts: ids.length,
      devices,
      projects,
      jobs,
      oauthLoaded: true,
      isolatedLoopback: true,
    }),
  );
} finally {
  mcp?.close();
  await hub?.close();
  await rm(directory, { recursive: true, force: true });
}
