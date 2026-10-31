import { readFileSync } from 'node:fs';
import { mkdir, open, rename, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dispatch, JobUpdate, AgentConfig } from '../shared/protocol.js';
import { hash } from './files.js';
export interface Acceptance {
  lockKey?: string;
  dispatch: Dispatch;
  digest: string;
  acceptedAt: string;
  config: Pick<AgentConfig, 'roots' | 'allowShell' | 'allowBrowser'>;
}
export interface LocalStatus extends JobUpdate {
  pid?: number;
  heartbeat?: string;
  processGroup?: number;
}
export const jobDir = (dataDir: string, id: string) => path.join(dataDir, 'jobs', hash(id));
export const lockDir = (dataDir: string, id: string) => path.join(dataDir, 'locks', hash(id));
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const h = await open(tmp, 'wx', 0o600);
  try {
    await h.writeFile(JSON.stringify(value, null, 2));
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, file);
  const d = await open(path.dirname(file), 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
export function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
      } catch {}
    }
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export function processGroupAlive(pgid: number | undefined) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export async function acceptances(dataDir: string) {
  let dirs: string[];
  try {
    dirs = await readdir(path.join(dataDir, 'jobs'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const result: Array<{ dir: string; record: Acceptance }> = [];
  for (const d of dirs) {
    const dir = path.join(dataDir, 'jobs', d);
    try {
      result.push({ dir, record: await readJson<Acceptance>(path.join(dir, 'accepted.json')) });
    } catch {
      /* Incomplete acceptance remains locked and cannot run. */
    }
  }
  return result;
}
export async function releaseLock(dataDir: string, projectId: string, jobId: string) {
  const dir = lockDir(dataDir, projectId);
  try {
    const lock = await readJson<{ jobId: string }>(path.join(dir, 'owner.json'));
    if (lock.jobId === jobId) await rm(dir, { recursive: true, force: true });
  } catch {
    /* Retain ambiguous locks. */
  }
}
