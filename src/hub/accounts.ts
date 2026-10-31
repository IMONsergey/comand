import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HubError, hashToken } from './store.js';
import type { AccountUser } from '../shared/protocol.js';

export const OWNER = 'owner';
export const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const passwordSchema = z.string().min(12).max(128);
const emailSchema = z.string().trim().toLowerCase().max(254).email();
const registrationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();
type AccountRow = {
  id: string;
  name: string;
  email: string;
  password: string;
  recovery_hash: string;
  version: number;
};
export interface AccountSession {
  principal: string;
  expires: number;
}
const invalidCredentials = () => new HubError(401, 'Invalid credentials', 'invalid_credentials');
function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HubError(
      400,
      'Check the name, email and password (12–128 characters)',
      'invalid_request',
    );
  return result.data;
}

// Bound memory consumption as well as IP/account attempts. KDF work never blocks the event loop.
let activeKdfs = 0;
const kdfQueue: Array<() => void> = [];
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeKdfs >= 4) {
    if (kdfQueue.length >= 12)
      throw new HubError(429, 'Authentication is busy. Try again shortly.', 'rate_limited');
    await new Promise<void>((resolve) => kdfQueue.push(resolve));
  } else activeKdfs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    const next = kdfQueue.shift();
    if (next) next();
    else activeKdfs--;
  }
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt:32768:8:1:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}
const dummyHash = `scrypt:32768:8:1:${'00'.repeat(16)}:${'00'.repeat(64)}`;
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [kind, n, r, p, salt, digest] = encoded.split(':');
  if (
    kind !== 'scrypt' ||
    n !== '32768' ||
    r !== '8' ||
    p !== '1' ||
    !/^[a-f0-9]{32}$/.test(salt ?? '') ||
    !/^[a-f0-9]{128}$/.test(digest ?? '')
  )
    throw new Error('Invalid persisted password hash');
  const actual = await derive(password, Buffer.from(salt!, 'hex'));
  return timingSafeEqual(actual, Buffer.from(digest!, 'hex'));
}

/** Identity, hashed sessions and agent routing; execution data lives only in per-principal stores. */
export class AccountsStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly loginAttempts = new Map<string, { count: number; expires: number }>();
  constructor(dataDir: string) {
    const path = join(dataDir, 'accounts.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, recovery_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, principal TEXT NOT NULL, version INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal);
      CREATE TABLE IF NOT EXISTS agent_pairings(hash TEXT PRIMARY KEY, principal TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_credentials(hash TEXT PRIMARY KEY, principal TEXT NOT NULL);`);
  }
  private row(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
  }
  user(id: string): AccountUser | undefined {
    const row = this.row(id);
    return row ? { id: row.id, name: row.name, email: row.email } : undefined;
  }
  version(id: string): number | undefined {
    return this.row(id)?.version ?? (id === OWNER ? 0 : undefined);
  }
  private byEmail(email: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE email=?').get(email) as
      AccountRow | undefined;
  }
  async register(
    input: unknown,
    claimOwner = false,
  ): Promise<{ principal: string; recoveryCode: string }> {
    const value = parse(registrationSchema, input);
    const password = await hashPassword(value.password);
    if (claimOwner && this.row(OWNER))
      throw new HubError(409, 'Owner workspace already has an account', 'already_claimed');
    const principal = claimOwner ? OWNER : randomUUID();
    const recoveryCode = randomBytes(32).toString('base64url');
    try {
      this.db
        .prepare('INSERT INTO accounts(id,name,email,password,recovery_hash) VALUES(?,?,?,?,?)')
        .run(principal, value.name, value.email, password, hashToken(recoveryCode));
    } catch (error) {
      if (this.byEmail(value.email))
        throw new HubError(409, 'This email is already registered', 'email_in_use');
      if (claimOwner && this.row(OWNER))
        throw new HubError(409, 'Owner workspace already has an account', 'already_claimed');
      throw error;
    }
    return { principal, recoveryCode };
  }
  async authenticate(input: unknown): Promise<string | undefined> {
    const parsed = z
      .object({ email: emailSchema, password: z.string().min(1).max(128) })
      .strict()
      .safeParse(input);
    if (!parsed.success) return;
    // Shared by browser and OAuth consent, so either endpoint cannot bypass account throttling.
    const key = hashToken(parsed.data.email);
    const old = this.loginAttempts.get(key);
    const attempts =
      old && old.expires > Date.now() ? old : { count: 0, expires: Date.now() + 60_000 };
    attempts.count++;
    this.loginAttempts.set(key, attempts);
    if (this.loginAttempts.size > 10000)
      this.loginAttempts.delete(this.loginAttempts.keys().next().value!);
    if (attempts.count > 12)
      throw new HubError(
        429,
        'Too many authentication attempts. Try again shortly.',
        'rate_limited',
      );
    const row = this.byEmail(parsed.data.email);
    const matches = await verifyPassword(parsed.data.password, row?.password ?? dummyHash);
    // Credentials might have changed while the asynchronous KDF was running.
    if (matches && row && this.row(row.id)?.password === row.password) return row.id;
  }
  async recover(input: unknown): Promise<{ principal: string; recoveryCode: string }> {
    const value = parse(
      z
        .object({
          email: emailSchema,
          recoveryCode: z.string().min(1).max(128),
          password: passwordSchema,
        })
        .strict(),
      input,
    );
    const password = await hashPassword(value.password);
    const row = this.byEmail(value.email);
    if (
      !row ||
      !timingSafeEqual(Buffer.from(hashToken(value.recoveryCode)), Buffer.from(row.recovery_hash))
    )
      throw invalidCredentials();
    const recoveryCode = randomBytes(32).toString('base64url');
    // Atomic compare-and-swap makes a recovery code single-use under concurrent requests.
    const updated = this.db
      .prepare(
        'UPDATE accounts SET password=?,recovery_hash=?,version=version+1 WHERE id=? AND recovery_hash=?',
      )
      .run(password, hashToken(recoveryCode), row.id, row.recovery_hash);
    if (!updated.changes) throw invalidCredentials();
    this.revokeSessions(row.id);
    return { principal: row.id, recoveryCode };
  }
  async changePassword(id: string, input: unknown): Promise<void> {
    const value = parse(
      z.object({ currentPassword: z.string().min(1).max(128), password: passwordSchema }).strict(),
      input,
    );
    const row = this.row(id);
    if (!(await verifyPassword(value.currentPassword, row?.password ?? dummyHash)) || !row)
      throw invalidCredentials();
    const password = await hashPassword(value.password);
    const updated = this.db
      .prepare('UPDATE accounts SET password=?,version=version+1 WHERE id=? AND version=?')
      .run(password, id, row.version);
    if (!updated.changes) throw invalidCredentials();
    this.revokeSessions(id);
  }
  createSession(principal: string): { id: string; expires: number } {
    const version = this.version(principal);
    if (version === undefined) throw invalidCredentials();
    const id = randomBytes(32).toString('base64url');
    const expires = Date.now() + SESSION_LIFETIME;
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    // Keep a bounded number per account without evicting sessions belonging to other users.
    this.db
      .prepare(
        'DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE principal=? ORDER BY expires DESC LIMIT -1 OFFSET 19)',
      )
      .run(principal);
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(hashToken(id), principal, version, expires);
    return { id, expires };
  }
  session(id: string): AccountSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
    const row = this.db
      .prepare('SELECT principal,version,expires FROM sessions WHERE hash=? AND expires>?')
      .get(hashToken(id), Date.now()) as (AccountSession & { version: number }) | undefined;
    if (row && row.version === this.version(row.principal)) return row;
  }
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hashToken(id));
  }
  private revokeSessions(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE principal=?').run(id);
  }
  mapPairing(code: string, principal: string, expires: string): void {
    this.db.prepare('DELETE FROM agent_pairings WHERE expires<=?').run(Date.now());
    this.db
      .prepare('INSERT INTO agent_pairings VALUES(?,?,?)')
      .run(hashToken(code), principal, Date.parse(expires));
  }
  pairingPrincipal(code: string): string | undefined {
    return (
      this.db
        .prepare('SELECT principal FROM agent_pairings WHERE hash=? AND expires>?')
        .get(hashToken(code), Date.now()) as { principal: string } | undefined
    )?.principal;
  }
  mapDevice(token: string, principal: string, pairingCode: string): void {
    this.db.prepare('INSERT INTO agent_credentials VALUES(?,?)').run(hashToken(token), principal);
    this.db.prepare('DELETE FROM agent_pairings WHERE hash=?').run(hashToken(pairingCode));
  }
  devicePrincipal(token: string): string | undefined {
    return (
      this.db
        .prepare('SELECT principal FROM agent_credentials WHERE hash=?')
        .get(hashToken(token)) as { principal: string } | undefined
    )?.principal;
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
