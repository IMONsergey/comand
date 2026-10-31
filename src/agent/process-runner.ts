// This private child is the process-group leader. Only it signals its OWN group;
// neither the broker nor a recovered agent ever kills a PID read from a state file.
// Keeping the leader alive until group cleanup prevents PID-reuse termination.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './state.js';
import type { ProcessRecord } from './processes.js';

export async function runProcessGroup(dir: string) {
  // Disconnect can happen during Node/tsx startup before listeners exist.
  if (!process.connected) return;
  const notify = (message: unknown) => {
    if (process.connected) process.send?.(message as object, () => {});
  };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Our SIGTERM listener prevents self-termination during the grace period.
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(1);
      }
    }, 1500);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', stop);
  process.stdout.on('error', stop);
  process.stderr.on('error', stop);
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'stop' in message && message.stop === true)
      stop();
  });
  const record = await readJson<ProcessRecord>(path.join(dir, 'session.json'));
  if (!process.connected || stopping) return;
  const child = spawn('/bin/sh', ['-c', record.command], {
    cwd: record.scope.root,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.once('spawn', () => notify({ ready: true }));
  child.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', (error) => {
    notify({ error: error.message });
    stop();
  });
  child.once('exit', (code, signal) => {
    notify({ exited: true, code, signal });
    // Clean up background descendants while the group leader is still ours.
    stop();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir || !process.send) throw Error('Process runner requires private broker IPC');
  await runProcessGroup(dir);
}
