#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const backup = spawnSync(
  'python3',
  [fileURLToPath(new URL('./backup-hub.py', import.meta.url)), ...process.argv.slice(2)],
  { encoding: 'utf8' },
);
if (backup.status !== 0) {
  console.error('Hub backup failed. Inspect the backup service; no credentials are printed.');
  process.exit(1);
}
const result = JSON.parse(backup.stdout);
if (!result.snapshot) throw Error('Expected a new backup snapshot');
const drill = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./restore-drill.mjs', import.meta.url)), result.snapshot],
  { encoding: 'utf8' },
);
if (drill.status !== 0) {
  console.error('Restore drill failed. The new snapshot is retained for inspection.');
  process.exit(1);
}
console.log(JSON.stringify({ ...result, restore: JSON.parse(drill.stdout) }));
