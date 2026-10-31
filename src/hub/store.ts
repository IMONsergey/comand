import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, posix } from 'node:path';
import { z } from 'zod';
import {
  discoveryInputSchema,
  discoveryResultSchema,
  type Discovery,
  type DiscoveryInput,
} from '../shared/discovery.js';
import {
  createJobSchema,
  jobStates,
  MAX_LOG_CHUNK,
  terminalStates,
  type AgentEnrollment,
  type AgentCredentials,
  type CreateJobInput,
  type Device,
  type Job,
  type JobUpdate,
  type LogChunk,
  type Pairing,
  type PairingStatus,
  type PollResponse,
  type Project,
} from '../shared/protocol.js';
export const MAX_JOB_LOG_BYTES = 10 * 1024 * 1024;
export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\x00-\x1f]/.test(s));
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      p.startsWith('/') && !p.includes('\0') && !p.includes('\\') && !p.split('/').includes('..'),
    'An absolute path without traversal is required',
  );
const enrollmentSchema = z
  .object({
    pairingCode: z.string().min(10).max(100),
    name: nameSchema,
    platform: z.enum(['linux', 'darwin']),
    roots: z.array(pathSchema).min(1).max(32),
    allowShell: z.boolean(),
    allowBrowser: z.boolean(),
    version: z.string().min(1).max(100),
  })
  .strict();
const heartbeatSchema = z
  .object({
    projectDiscovery: z.boolean().optional(),
    roots: z.array(pathSchema).min(1).max(32).optional(),
    version: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value))
      .optional(),
  })
  .strict();
const updateSchema = z
  .object({
    jobId: z.string().max(100),
    status: z.enum(jobStates),
    startedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional(),
    exitCode: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
    error: z.string().max(16384).nullable().optional(),
    result: z.unknown().optional(),
    log: z
      .object({
        offset: z.number().int().min(0),
        data: z.string().max(Math.ceil(MAX_LOG_CHUNK / 3) * 4),
      })
      .strict()
      .optional(),
  })
  .strict();
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new HubError(
      400,
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(';'),
    );
  return r.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function within(root: string, path: string) {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}
// Keep a UTF-8 prefix pending when a byte chunk ends inside a character.
// Invalid byte sequences still decode with replacement characters normally.
function completeUtf8End(bytes: Buffer, end: number): number {
  if (!end) return 0;
  let start = end - 1;
  while (start >= Math.max(0, end - 4) && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0 || start < end - 4) return end;
  const lead = bytes[start]!;
  const expected =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  return end - start < expected ? start : end;
}
export class HubStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(dataDir: string, adminToken: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.db = new DatabaseSync(join(dataDir, 'hub.sqlite'));
    chmodSync(join(dataDir, 'hub.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pairings(code_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pairing_status(id TEXT PRIMARY KEY,code_hash TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,device_id TEXT REFERENCES devices(id));
   CREATE INDEX IF NOT EXISTS pairing_status_expiry ON pairing_status(expires_at);
   CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS discoveries(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,device_id TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,logs BLOB NOT NULL DEFAULT X'');
   CREATE UNIQUE INDEX IF NOT EXISTS one_active_project ON jobs(project_id) WHERE status IN ('queued','dispatched','running','uncertain');`);
    const boundOwner = this.db
      .prepare("SELECT value FROM metadata WHERE key='admin_token_hash'")
      .get() as { value: string } | undefined;
    if (boundOwner && boundOwner.value !== hashToken(adminToken)) {
      this.db.close();
      throw new Error(
        'This workspace belongs to a different owner key. Restore the original admin.token.',
      );
    }
    this.db
      .prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)')
      .run('admin_token_hash', hashToken(adminToken));
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private decode<T>(row: unknown): T | undefined {
    return row
      ? (JSON.parse(
          (
            row as {
              data: string;
            }
          ).data,
        ) as T)
      : undefined;
  }
  private saveJob(job: Job) {
    this.db
      .prepare('UPDATE jobs SET status=?,data=? WHERE id=?')
      .run(job.status, JSON.stringify(job), job.id);
  }
  private requiredJob(id: string) {
    const job = this.getJob(id);
    if (!job) throw new HubError(404, 'Job not found', 'not_found');
    return job;
  }
  private requiredDevice(id: string) {
    const device = this.getDevice(id);
    if (!device) throw new HubError(404, 'Device not found', 'not_found');
    if (device.revokedAt) throw new HubError(403, 'Device has been revoked', 'device_revoked');
    return device;
  }
  listDevices(): Device[] {
    return this.db
      .prepare('SELECT data FROM devices ORDER BY rowid DESC')
      .all()
      .map((row) => this.decorateDevice(this.decode<Device>(row)!));
  }
  private decorateDevice(device: Device): Device {
    device.online =
      !device.revokedAt &&
      !!device.lastSeenAt &&
      Date.now() - Date.parse(device.lastSeenAt) < 30000;
    return device;
  }
  getDevice(id: string): Device | undefined {
    const d = this.decode<Device>(this.db.prepare('SELECT data FROM devices WHERE id=?').get(id));
    return d && this.decorateDevice(d);
  }
  authenticateDevice(token: string): string | null {
    const row = this.db
      .prepare('SELECT data FROM devices WHERE token_hash=?')
      .get(hashToken(token));
    const d = this.decode<Device>(row);
    return d && !d.revokedAt ? d.id : null;
  }
  createPairing(): Pairing {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(now());
      this.db
        .prepare('DELETE FROM pairing_status WHERE expires_at < ?')
        .run(this.pairingStatusCutoff());
      const id = randomUUID();
      const code = randomBytes(18).toString('base64url');
      const expiresAt = new Date(Date.now() + 600000).toISOString();
      const codeHash = hashToken(code);
      this.db.prepare('INSERT INTO pairings VALUES(?,?)').run(codeHash, expiresAt);
      this.db
        .prepare('INSERT INTO pairing_status(id,code_hash,expires_at) VALUES(?,?,?)')
        .run(id, codeHash, expiresAt);
      return { id, code, expiresAt };
    });
  }
  private pairingStatusCutoff(): string {
    // Let an open installation screen observe expiry/completion for a day, then discard receipts.
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }
  getPairingStatus(id: string): PairingStatus {
    const row = this.db
      .prepare('SELECT expires_at,device_id FROM pairing_status WHERE id=? AND expires_at>=?')
      .get(id, this.pairingStatusCutoff()) as
      { expires_at: string; device_id: string | null } | undefined;
    if (!row) throw new HubError(404, 'Pairing not found', 'not_found');
    return {
      expiresAt: row.expires_at,
      device: row.device_id ? (this.getDevice(row.device_id) ?? null) : null,
    };
  }
  enroll(input: AgentEnrollment): AgentCredentials {
    const value = parse(enrollmentSchema, input);
    return this.transaction(() => {
      const pairing = this.db
        .prepare('SELECT expires_at FROM pairings WHERE code_hash=?')
        .get(hashToken(value.pairingCode)) as
        | {
            expires_at: string;
          }
        | undefined;
      if (!pairing || pairing.expires_at < now())
        throw new HubError(401, 'Invalid or expired pairing code', 'invalid_pairing');
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const device: Device = {
        id,
        name: value.name,
        platform: value.platform,
        roots: [...new Set(value.roots.map((p) => posix.normalize(p).replace(/\/$/, '') || '/'))],
        allowShell: value.allowShell,
        allowBrowser: value.allowBrowser,
        version: value.version,
        createdAt: now(),
        lastSeenAt: null,
        revokedAt: null,
        online: false,
      };
      this.db
        .prepare('INSERT INTO devices VALUES(?,?,?)')
        .run(id, hashToken(token), JSON.stringify(device));
      // Device creation, receipt completion and secret consumption commit together.
      // Codes created by older releases have no receipt and remain valid for enrollment.
      this.db
        .prepare('UPDATE pairing_status SET device_id=? WHERE code_hash=?')
        .run(id, hashToken(value.pairingCode));
      this.db.prepare('DELETE FROM pairings WHERE code_hash=?').run(hashToken(value.pairingCode));
      return { deviceId: id, token };
    });
  }
  revokeDevice(id: string): Device {
    const device = this.getDevice(id);
    if (!device) throw new HubError(404, 'Device not found', 'not_found');
    device.revokedAt ??= now();
    device.online = false;
    this.db.prepare('UPDATE devices SET data=? WHERE id=?').run(JSON.stringify(device), id);
    return device;
  }
  listProjects(): Project[] {
    return this.db
      .prepare('SELECT data FROM projects ORDER BY rowid DESC')
      .all()
      .map((row) => this.decode<Project>(row)!);
  }
  getProject(id: string): Project | undefined {
    return this.decode<Project>(this.db.prepare('SELECT data FROM projects WHERE id=?').get(id));
  }
  createDiscovery(input: DiscoveryInput): Discovery {
    const value = parse(discoveryInputSchema, input);
    const device = this.requiredDevice(value.deviceId);
    if (!device.projectDiscovery)
      throw new HubError(
        409,
        'Обновите агент на устройстве: поиск проектов пока не поддерживается',
        'agent_update_required',
      );
    if (!device.online)
      throw new HubError(
        409,
        'Устройство не в сети. Включите его и повторите поиск',
        'device_offline',
      );
    if (
      value.path &&
      (!value.path.startsWith('/') ||
        !device.roots.some((root) => within(root, posix.normalize(value.path!))))
    )
      throw new HubError(400, 'Папка вне разрешённой области поиска', 'invalid_root');
    this.db
      .prepare("DELETE FROM discoveries WHERE json_extract(data,'$.expiresAt') < ?")
      .run(new Date(Date.now() - 86400000).toISOString());
    const pending = this.db.prepare('SELECT id FROM discoveries WHERE device_id=?').all(device.id);
    for (const row of pending) {
      const existing = this.getDiscovery(row.id as string);
      if (existing.status !== 'queued') continue;
      if (existing.query === value.query && existing.path === value.path) return existing;
      throw new HubError(
        409,
        'На устройстве уже идёт поиск. Дождитесь его завершения',
        'discovery_busy',
      );
    }
    if ((this.db.prepare('SELECT count(*) AS n FROM discoveries').get() as { n: number }).n >= 500)
      throw new HubError(429, 'Слишком много поисков. Повторите позже', 'rate_limited');
    const discovery: Discovery = {
      ...value,
      id: randomUUID(),
      status: 'queued',
      createdAt: now(),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    this.db
      .prepare('INSERT INTO discoveries VALUES(?,?,?)')
      .run(discovery.id, device.id, JSON.stringify(discovery));
    return discovery;
  }
  getDiscovery(id: string): Discovery {
    const discovery = this.decode<Discovery>(
      this.db.prepare('SELECT data FROM discoveries WHERE id=?').get(id),
    );
    if (!discovery) throw new HubError(404, 'Поиск не найден', 'not_found');
    this.requiredDevice(discovery.deviceId);
    if (discovery.status === 'queued' && discovery.expiresAt <= now()) {
      discovery.status = 'expired';
      discovery.error = 'Устройство не ответило вовремя. Повторите поиск';
      this.db
        .prepare('UPDATE discoveries SET data=? WHERE id=?')
        .run(JSON.stringify(discovery), id);
    }
    return discovery;
  }
  completeDiscovery(deviceId: string, id: string, input: unknown): Discovery {
    const device = this.requiredDevice(deviceId);
    const discovery = this.getDiscovery(id);
    if (discovery.deviceId !== deviceId)
      throw new HubError(403, 'Поиск принадлежит другому устройству', 'device_mismatch');
    if (discovery.status !== 'queued') return discovery;
    const value = parse(
      z.union([
        z.object({ result: discoveryResultSchema }).strict(),
        z.object({ error: z.string().min(1).max(1000) }).strict(),
      ]),
      input,
    );
    if ('result' in value) {
      if (
        ![
          ...value.result.roots,
          ...value.result.candidates.map((candidate) => candidate.root),
        ].every(
          (root) =>
            root.startsWith('/') &&
            !root.split('/').includes('..') &&
            device.roots.some((allowed) => within(allowed, root)),
        )
      )
        throw new HubError(400, 'Результат выходит за разрешённые папки', 'invalid_root');
      discovery.status = 'succeeded';
      discovery.result = value.result;
    } else {
      discovery.status = 'failed';
      discovery.error = value.error;
    }
    discovery.expiresAt = new Date(Date.now() + 600000).toISOString();
    this.db.prepare('UPDATE discoveries SET data=? WHERE id=?').run(JSON.stringify(discovery), id);
    return discovery;
  }
  openDiscoveredProject(input: { discoveryId: string; root: string }): Project {
    const value = parse(
      z.object({ discoveryId: z.string().max(100), root: pathSchema }).strict(),
      input,
    );
    const discovery = this.getDiscovery(value.discoveryId);
    if (discovery.status !== 'succeeded' || discovery.expiresAt <= now())
      throw new HubError(409, 'Обновите поиск перед выбором папки', 'stale_discovery');
    const candidate = discovery.result?.candidates.find((item) => item.root === value.root);
    if (!candidate)
      throw new HubError(400, 'Папка отсутствует в результатах поиска', 'invalid_root');
    if (!this.requiredDevice(discovery.deviceId).roots.some((root) => within(root, candidate.root)))
      throw new HubError(400, 'Папка больше не разрешена на устройстве', 'invalid_root');
    return (
      this.listProjects().find(
        (project) => project.deviceId === discovery.deviceId && project.root === candidate.root,
      ) ??
      this.createProject({
        deviceId: discovery.deviceId,
        root: candidate.root,
        name: candidate.name,
      })
    );
  }
  createProject(input: { deviceId: string; name: string; root: string; notes?: string }): Project {
    const value = parse(
      z
        .object({
          deviceId: z.string().max(100),
          name: nameSchema,
          root: pathSchema,
          notes: z.string().max(50000).optional(),
        })
        .strict(),
      input,
    );
    return this.transaction(() => {
      const device = this.requiredDevice(value.deviceId);
      const root = posix.normalize(value.root).replace(/\/$/, '') || '/';
      if (!device.roots.some((r) => within(r, root)))
        throw new HubError(
          400,
          'Project root must be inside a registered device root',
          'invalid_root',
        );
      if (
        this.db
          .prepare(
            "SELECT id FROM projects WHERE json_extract(data, '$.deviceId')=? AND json_extract(data, '$.root')=?",
          )
          .get(device.id, root)
      )
        throw new HubError(
          409,
          'A project already uses this root on the device',
          'duplicate_project_root',
        );
      const project: Project = {
        ...value,
        root,
        notes: value.notes ?? '',
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
      };
      this.db.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, JSON.stringify(project));
      return project;
    });
  }
  updateProject(
    id: string,
    input: {
      name?: string;
      notes?: string;
    },
  ): Project {
    const value = parse(
      z.object({ name: nameSchema.optional(), notes: z.string().max(50000).optional() }).strict(),
      input,
    );
    const project = this.getProject(id);
    if (!project) throw new HubError(404, 'Project not found', 'not_found');
    Object.assign(project, value, { updatedAt: now() });
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), id);
    return project;
  }
  listJobs(limit = 200): Job[] {
    // List/overview responses are summaries: retain the Job shape with
    // result:null. Retrieve potentially large results only through getJob.
    // Strip results and process stdin inside SQLite so they never cross into the JS list.
    // Input may contain terminal credentials; detail/dispatch retain the original payload.
    return this.db
      .prepare(
        `SELECT CASE WHEN json_extract(data, '$.operation.kind') = 'process.input'
          THEN json_set(data, '$.result', NULL, '$.operation.input', '')
          ELSE json_set(data, '$.result', NULL) END AS data
          FROM jobs ORDER BY rowid DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, Math.floor(limit))))
      .map((row) => this.decode<Job>(row)!);
  }
  getJobCounts(): Record<Job['status'], number> {
    const counts: Record<Job['status'], number> = {
      queued: 0,
      dispatched: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      uncertain: 0,
    };
    for (const row of this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all()) {
      counts[row.status as Job['status']] = Number(row.count);
    }
    return counts;
  }
  getJob(id: string): Job | undefined {
    return this.decode<Job>(this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id));
  }
  createJob(input: CreateJobInput): Job {
    const value = parse(createJobSchema, input);
    if (
      value.operation.kind === 'files.write' &&
      Buffer.byteLength(value.operation.content) > 1024 * 1024
    )
      throw new HubError(413, 'File content exceeds one MiB', 'too_large');
    const payload = canonical({ projectId: value.projectId, operation: value.operation });
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT payload,data FROM jobs WHERE idempotency_key=?')
        .get(value.idempotencyKey) as
        | {
            payload: string;
            data: string;
          }
        | undefined;
      if (existing) {
        if (existing.payload !== payload)
          throw new HubError(
            409,
            'Idempotency key already used with another payload',
            'idempotency_conflict',
          );
        return JSON.parse(existing.data) as Job;
      }
      const project = this.getProject(value.projectId);
      if (!project) throw new HubError(404, 'Project not found', 'not_found');
      const device = this.requiredDevice(project.deviceId);
      if (
        (value.operation.kind === 'command' || value.operation.kind.startsWith('process.')) &&
        !device.allowShell
      )
        throw new HubError(
          403,
          'Shell commands are disabled on this device',
          'capability_disabled',
        );
      if (value.operation.kind === 'browser.inspect' && !device.allowBrowser)
        throw new HubError(
          403,
          'Browser inspection is disabled on this device',
          'capability_disabled',
        );
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','dispatched','running','uncertain')",
          )
          .get(project.id)
      )
        throw new HubError(409, 'Project has an active or uncertain job', 'project_busy');
      const job: Job = {
        ...value,
        id: randomUUID(),
        deviceId: device.id,
        status: 'queued',
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        exitCode: null,
        error: null,
        result: null,
        logBytes: 0,
      };
      this.db
        .prepare(
          'INSERT INTO jobs(id,project_id,device_id,idempotency_key,payload,status,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          job.id,
          project.id,
          device.id,
          job.idempotencyKey,
          payload,
          job.status,
          JSON.stringify(job),
        );
      return job;
    });
  }
  findJobByIdempotencyKey(key: string): Job | undefined {
    return this.decode<Job>(
      this.db.prepare('SELECT data FROM jobs WHERE idempotency_key=?').get(key),
    );
  }
  cancelJob(id: string): Job {
    return this.transaction(() => {
      const job = this.requiredJob(id);
      if (!terminalStates.has(job.status)) {
        job.cancelRequestedAt ??= now();
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.finishedAt = now();
        }
        this.saveJob(job);
      }
      return job;
    });
  }
  poll(deviceId: string, heartbeat: unknown = {}): PollResponse {
    const value = parse(heartbeatSchema, heartbeat);
    return this.transaction(() => {
      const device = this.requiredDevice(deviceId);
      device.lastSeenAt = now();
      if (value.version !== undefined) device.version = value.version;
      if (value.projectDiscovery !== undefined) device.projectDiscovery = value.projectDiscovery;
      if (value.roots !== undefined)
        device.roots = [
          ...new Set(value.roots.map((root) => posix.normalize(root).replace(/\/$/, '') || '/')),
        ];
      this.db.prepare('UPDATE devices SET data=? WHERE id=?').run(JSON.stringify(device), deviceId);
      const jobs = this.db
        .prepare(
          "SELECT data FROM jobs WHERE device_id=? AND status IN ('queued','dispatched','running','uncertain') ORDER BY rowid",
        )
        .all(deviceId)
        .map((row) => this.decode<Job>(row)!);
      const projects = new Map(jobs.map((job) => [job.projectId, this.getProject(job.projectId)!]));
      // Dispatched, running and uncertain work retains its entire root.
      // A queued job takes that lock atomically when first dispatched.
      const lockedRoots = jobs
        .filter((job) => job.status !== 'queued')
        .map((job) => projects.get(job.projectId)!.root);
      const dispatches: PollResponse['jobs'] = [];
      for (const job of jobs) {
        const project = projects.get(job.projectId)!;
        if (job.status === 'dispatched') {
          dispatches.push({ job, project });
        } else if (
          job.status === 'queued' &&
          !lockedRoots.some((root) => within(root, project.root) || within(project.root, root))
        ) {
          job.status = 'dispatched';
          this.saveJob(job);
          lockedRoots.push(project.root);
          dispatches.push({ job, project });
        }
      }
      return {
        ...(value.projectDiscovery
          ? {
              discoveries: this.db
                .prepare('SELECT id FROM discoveries WHERE device_id=?')
                .all(deviceId)
                .map((row) => this.getDiscovery(row.id as string))
                .filter((item) => item.status === 'queued')
                .slice(0, 1),
            }
          : {}),
        jobs: dispatches,
        cancellations: jobs.filter((job) => job.cancelRequestedAt).map((job) => job.id),
        serverTime: now(),
      };
    });
  }
  updateJob(
    deviceId: string,
    input: JobUpdate,
  ): {
    logBytes: number;
    status: Job['status'];
  } {
    const value = parse(updateSchema, input);
    if (
      value.result !== undefined &&
      Buffer.byteLength(JSON.stringify(value.result)) > 3 * 1024 * 1024
    )
      throw new HubError(413, 'Job result exceeds three MiB', 'too_large');
    return this.transaction(() => {
      this.requiredDevice(deviceId);
      const job = this.requiredJob(value.jobId);
      if (job.deviceId !== deviceId)
        throw new HubError(403, 'Job belongs to another device', 'device_mismatch');
      if (job.status === 'queued')
        throw new HubError(409, 'Job has not been dispatched', 'invalid_transition');
      const allowed: Record<Job['status'], Job['status'][]> = {
        queued: [],
        dispatched: ['dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'],
        running: ['running', 'succeeded', 'failed', 'cancelled', 'uncertain'],
        uncertain: ['uncertain', 'succeeded', 'failed', 'cancelled'],
        succeeded: ['succeeded'],
        failed: ['failed'],
        cancelled: ['cancelled'],
      };
      if (!allowed[job.status].includes(value.status))
        throw new HubError(409, 'Job state cannot regress', 'invalid_transition');
      if (value.log) {
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.log.data)
        )
          throw new HubError(400, 'Invalid base64 log data');
        const bytes = Buffer.from(value.log.data, 'base64');
        if (bytes.length > MAX_LOG_CHUNK)
          throw new HubError(413, 'Log chunk is too large', 'too_large');
        const row = this.db.prepare('SELECT logs FROM jobs WHERE id=?').get(job.id) as {
          logs: Uint8Array;
        };
        const logs = Buffer.from(row.logs);
        const offset = value.log.offset;
        if (offset > logs.length) throw new HubError(409, 'Log offset has a gap', 'log_offset');
        // A lost acknowledgment can replay a saved prefix plus newly produced
        // output in one chunk. Verify every overlapping byte before appending
        // only the unseen tail; the surrounding transaction commits both the
        // bytes and state/cursor together, or preserves everything on conflict.
        const overlap = Math.min(bytes.length, logs.length - offset);
        if (!logs.subarray(offset, offset + overlap).equals(bytes.subarray(0, overlap)))
          throw new HubError(409, 'Log replay does not match stored bytes', 'log_conflict');
        const tail = bytes.subarray(overlap);
        if (tail.length) {
          if (logs.length + tail.length > MAX_JOB_LOG_BYTES)
            throw new HubError(413, 'Job log limit reached; agent must truncate logs', 'log_limit');
          this.db
            .prepare('UPDATE jobs SET logs=? WHERE id=?')
            .run(Buffer.concat([logs, tail]), job.id);
          job.logBytes = logs.length + tail.length;
        }
      }
      if (!terminalStates.has(job.status)) {
        job.status = value.status;
        // Fast jobs may first report their terminal state. Preserve the
        // supervisor's start evidence without changing an already saved time.
        if (value.startedAt) job.startedAt ??= value.startedAt;
        if (value.status === 'running') job.startedAt ??= now();
        if (terminalStates.has(value.status)) job.finishedAt = value.finishedAt ?? now();
        if (value.exitCode !== undefined) job.exitCode = value.exitCode;
        if (value.error !== undefined) job.error = value.error;
        if (value.result !== undefined) job.result = value.result;
        this.saveJob(job);
      } else if (value.log) {
        this.saveJob(job);
      }
      return { logBytes: job.logBytes, status: job.status };
    });
  }
  getLogs(id: string, offset = 0, limit = MAX_LOG_CHUNK): LogChunk {
    const job = this.requiredJob(id);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LOG_CHUNK
    )
      throw new HubError(400, 'Invalid log offset or limit');
    const row = this.db.prepare('SELECT logs FROM jobs WHERE id=?').get(id) as {
      logs: Uint8Array;
    };
    const logs = Buffer.from(row.logs);
    if (offset > logs.length) throw new HubError(400, 'Offset exceeds log length');
    const readableEnd = terminalStates.has(job.status)
      ? logs.length
      : completeUtf8End(logs, logs.length);
    let end = Math.min(readableEnd, offset + limit);
    if (end < logs.length) end = completeUtf8End(logs, end);
    // Very small limits may extend by up to three bytes to make progress
    // without splitting one Unicode character. Offsets always count bytes.
    if (end <= offset && offset < readableEnd) {
      end = Math.min(readableEnd, offset + 4);
      if (end < logs.length) end = completeUtf8End(logs, end);
    }
    end = Math.max(offset, end);
    return {
      text: logs.subarray(offset, end).toString('utf8'),
      nextOffset: end,
      hasMore: end < readableEnd,
    };
  }
}
