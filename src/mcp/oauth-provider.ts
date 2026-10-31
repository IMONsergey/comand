import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OWNER } from '../hub/accounts.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';

export const SCOPES = ['comand:read', 'comand:write', 'comand:execute'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export interface PendingAuthorization {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  resource: string;
  state?: string;
  expires: number;
}
interface CodeRecord {
  principal: string;
  credential_version: number;
  hash: string;
  client_id: string;
  challenge: string;
  redirect_uri: string;
  scopes: string;
  resource: string;
  expires: number;
}
interface TokenRecord {
  hash: string;
  kind: string;
  client_id: string;
  grant_id: string;
  scopes: string;
  resource: string;
  expires: number;
  used: number;
}
export interface ConnectionGrant {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Per-principal authorization server; opaque, hashed tokens and rotating refresh families. */
export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = true; // PKCE is checked atomically with code consumption below.
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private closed = false;

  constructor(
    dataDir: string,
    readonly resource: URL,
    private readonly credentialVersion: (principal: string) => number | undefined = (id) =>
      id === OWNER ? 0 : undefined,
  ) {
    if (
      !['http:', 'https:'].includes(resource.protocol) ||
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash
    )
      throw new Error('Invalid MCP resource URL');
    if (
      resource.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(resource.hostname)
    )
      throw new Error('Remote OAuth requires HTTPS');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(dataDir, 'oauth.key');
    try {
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid OAuth encryption key');
    const path = join(dataDir, 'oauth.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_requests (id TEXT PRIMARY KEY, document TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), scopes TEXT NOT NULL, resource TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);`);
    // Migrations deliberately attach historical grants/codes to the legacy owner.
    for (const table of ['oauth_codes', 'oauth_grants']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (!columns.some((c) => c.name === 'principal'))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN principal TEXT NOT NULL DEFAULT 'owner'`);
      if (!columns.some((c) => c.name === 'credential_version'))
        this.db.exec(
          `ALTER TABLE ${table} ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0`,
        );
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS oauth_grants_principal ON oauth_grants(principal)');
    this.clientsStore = {
      getClient: (id) => this.getClient(id),
      registerClient: async (input) => {
        if (input.redirect_uris.length < 1 || input.redirect_uris.length > 8)
          throw new InvalidClientMetadataError('Supply between 1 and 8 redirect URLs');
        for (const raw of input.redirect_uris) {
          let url: URL;
          try {
            url = new URL(raw);
          } catch {
            throw new InvalidClientMetadataError('Invalid redirect URL');
          }
          if (
            raw.length > 2048 ||
            url.hash ||
            url.username ||
            url.password ||
            (url.protocol !== 'https:' &&
              !(
                url.protocol === 'http:' &&
                ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
              ))
          )
            throw new InvalidClientMetadataError(
              'Redirects require HTTPS, or HTTP loopback, and no fragment or credentials',
            );
        }
        if (
          input.token_endpoint_auth_method &&
          !['none', 'client_secret_post'].includes(input.token_endpoint_auth_method)
        )
          throw new InvalidClientMetadataError(
            'Supported client authentication: none or client_secret_post',
          );
        if (input.scope && input.scope.split(' ').some((s) => !SCOPES.includes(s)))
          throw new InvalidClientMetadataError('Unsupported scope');
        const count = this.db.prepare('SELECT count(*) AS n FROM oauth_clients').get() as {
          n: number;
        };
        if (count.n >= 256)
          throw new InvalidClientMetadataError(
            'Client registration limit reached; contact the owner',
          );
        const client: OAuthClientInformationFull = {
          ...input,
          client_id: secret(),
          client_id_issued_at: now(),
          client_name: input.client_name?.slice(0, 160),
        };
        this.db
          .prepare('INSERT INTO oauth_clients VALUES (?, ?)')
          .run(client.client_id, this.encrypt(JSON.stringify(client)));
        return client;
      },
    };
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  private getClient(id: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT document FROM oauth_clients WHERE id=?').get(id) as
      { document: string } | undefined;
    return row ? (JSON.parse(this.decrypt(row.document)) as OAuthClientInformationFull) : undefined;
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private validateResource(resource?: URL): string {
    if (resource && resource.href !== this.resource.href)
      throw new InvalidRequestError('Token audience must match this MCP endpoint');
    return this.resource.href;
  }

  createRequest(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): PendingAuthorization {
    this.validateResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('S256 PKCE is required');
    if (!client.redirect_uris.some((uri) => redirectUriMatches(params.redirectUri, uri)))
      throw new InvalidRequestError('Unregistered redirect URL');
    if (params.state && params.state.length > 2048)
      throw new InvalidRequestError('State is too long');
    const scopes = [...new Set(params.scopes?.length ? params.scopes : SCOPES)];
    if (scopes.some((s) => !SCOPES.includes(s))) throw new InvalidScopeError('Unknown scope');
    const request: PendingAuthorization = {
      id: secret(),
      clientId: client.client_id,
      clientName: client.client_name || 'MCP client',
      redirectUri: params.redirectUri,
      challenge: params.codeChallenge,
      scopes,
      resource: this.resource.href,
      state: params.state,
      expires: now() + 600,
    };
    this.db.prepare('DELETE FROM oauth_requests WHERE expires<?').run(now());
    this.db.prepare('DELETE FROM oauth_codes WHERE expires<?').run(now());
    this.db
      .prepare('INSERT INTO oauth_requests VALUES (?,?,?)')
      .run(request.id, JSON.stringify(request), request.expires);
    return request;
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const request = this.createRequest(client, params);
    res.redirect(303, `/oauth/consent?request=${encodeURIComponent(request.id)}`);
  }
  getRequest(id: string): PendingAuthorization {
    const row = this.db
      .prepare('SELECT document FROM oauth_requests WHERE id=? AND expires>?')
      .get(id, now()) as { document: string } | undefined;
    if (!row) throw new InvalidRequestError('Authorization request expired or already completed');
    return JSON.parse(row.document) as PendingAuthorization;
  }
  approveRequest(id: string, principal = OWNER): string {
    const version = this.credentialVersion(principal);
    if (version === undefined) throw new InvalidRequestError('Account is unavailable');
    return this.transaction(() => {
      const request = this.getRequest(id);
      const code = secret();
      this.db.prepare('DELETE FROM oauth_requests WHERE id=?').run(id);
      this.db
        .prepare(
          'INSERT INTO oauth_codes(hash,client_id,challenge,redirect_uri,scopes,resource,expires,principal,credential_version) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          hash(code),
          request.clientId,
          request.challenge,
          request.redirectUri,
          JSON.stringify(request.scopes),
          request.resource,
          now() + 120,
          principal,
          version,
        );
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set('code', code);
      if (request.state !== undefined) redirect.searchParams.set('state', request.state);
      return redirect.href;
    });
  }
  denyRequest(id: string): string {
    const request = this.getRequest(id);
    this.db.prepare('DELETE FROM oauth_requests WHERE id=?').run(id);
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (request.state !== undefined) redirect.searchParams.set('state', request.state);
    return redirect.href;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = this.db
      .prepare('SELECT * FROM oauth_codes WHERE hash=? AND client_id=? AND expires>?')
      .get(hash(authorizationCode), client.client_id, now()) as CodeRecord | undefined;
    if (
      !row ||
      row.credential_version !== this.credentialVersion(row.principal) ||
      row.resource !== this.resource.href
    )
      throw new InvalidGrantError('Invalid authorization code');
    return row.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.validateResource(resource);
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM oauth_codes WHERE hash=? AND client_id=? AND expires>?')
        .get(hash(code), client.client_id, now()) as CodeRecord | undefined;
      if (
        !row ||
        row.resource !== this.resource.href ||
        row.credential_version !== this.credentialVersion(row.principal) ||
        !verifier ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !redirectUri ||
        redirectUri !== row.redirect_uri
      )
        throw new InvalidGrantError('Invalid authorization code, redirect or verifier');
      const actual = createHash('sha256').update(verifier).digest('base64url');
      if (
        actual.length !== row.challenge.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(row.challenge))
      )
        throw new InvalidGrantError('Invalid PKCE verifier');
      this.db.prepare('DELETE FROM oauth_codes WHERE hash=?').run(hash(code));
      const grantId = secret();
      this.db
        .prepare(
          'INSERT INTO oauth_grants(id,client_id,scopes,created,principal,credential_version) VALUES (?,?,?,?,?,?)',
        )
        .run(grantId, client.client_id, row.scopes, now(), row.principal, row.credential_version);
      return this.issueTokens(client.client_id, grantId, JSON.parse(row.scopes) as string[]);
    });
  }
  private issueTokens(clientId: string, grantId: string, scopes: string[]): OAuthTokens {
    const access = secret();
    const refresh = secret();
    const insert = this.db.prepare(
      'INSERT INTO oauth_tokens(hash,kind,client_id,grant_id,scopes,resource,expires) VALUES (?,?,?,?,?,?,?)',
    );
    insert.run(
      hash(access),
      'access',
      clientId,
      grantId,
      JSON.stringify(scopes),
      this.resource.href,
      now() + 3600,
    );
    insert.run(
      hash(refresh),
      'refresh',
      clientId,
      grantId,
      JSON.stringify(scopes),
      this.resource.href,
      now() + 30 * 86_400,
    );
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.validateResource(resource);
    const row = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE hash=? AND kind=? AND client_id=?')
      .get(hash(token), 'refresh', client.client_id) as TokenRecord | undefined;
    if (!row || row.expires <= now() || row.resource !== this.resource.href)
      throw new InvalidGrantError('Invalid refresh token');
    if (row.used) {
      this.revokeGrantForToken(row.grant_id);
      throw new InvalidGrantError('Refresh token replay; connection revoked');
    }
    const grant = this.db
      .prepare('SELECT revoked,principal,credential_version FROM oauth_grants WHERE id=?')
      .get(row.grant_id) as
      { revoked: number | null; principal: string; credential_version: number } | undefined;
    if (
      !grant ||
      grant.revoked !== null ||
      grant.credential_version !== this.credentialVersion(grant.principal)
    )
      throw new InvalidGrantError('Connection revoked');
    const previous = JSON.parse(row.scopes) as string[];
    const requested = scopes?.length ? [...new Set(scopes)] : previous;
    if (requested.some((s) => !previous.includes(s)))
      throw new InvalidScopeError('Refresh cannot add permissions');
    return this.transaction(() => {
      const consumed = this.db
        .prepare('UPDATE oauth_tokens SET used=1 WHERE hash=? AND used=0')
        .run(row.hash);
      if (!consumed.changes) throw new InvalidGrantError('Refresh token already consumed');
      return this.issueTokens(client.client_id, row.grant_id, requested);
    });
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.length > 512) throw new InvalidTokenError('Invalid token');
    const row = this.db
      .prepare(
        "SELECT t.*,g.principal,g.credential_version FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE t.hash=? AND t.kind='access' AND g.revoked IS NULL AND t.expires>?",
      )
      .get(hash(token), now()) as
      (TokenRecord & { principal: string; credential_version: number }) | undefined;
    if (
      !row ||
      row.resource !== this.resource.href ||
      row.credential_version !== this.credentialVersion(row.principal)
    )
      throw new InvalidTokenError('Invalid or expired token');
    this.db.prepare('UPDATE oauth_grants SET last_used=? WHERE id=?').run(now(), row.grant_id);
    return {
      token,
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes) as string[],
      expiresAt: row.expires,
      resource: new URL(row.resource),
      extra: { principal: row.principal },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const row = this.db
      .prepare('SELECT grant_id FROM oauth_tokens WHERE hash=? AND client_id=?')
      .get(hash(request.token), client.client_id) as { grant_id: string } | undefined;
    if (row) this.revokeGrantForToken(row.grant_id);
  }
  listGrants(principal = OWNER): ConnectionGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM oauth_grants WHERE principal=? ORDER BY created DESC LIMIT 200')
      .all(principal) as unknown as Array<{
      id: string;
      client_id: string;
      scopes: string;
      created: number;
      last_used: number | null;
      revoked: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: this.getClient(row.client_id)?.client_name || 'MCP client',
      scopes: JSON.parse(row.scopes) as string[],
      createdAt: new Date(row.created * 1000).toISOString(),
      lastUsedAt: row.last_used ? new Date(row.last_used * 1000).toISOString() : null,
      revokedAt: row.revoked ? new Date(row.revoked * 1000).toISOString() : null,
    }));
  }
  revokeGrant(id: string, principal = OWNER): boolean {
    return !!this.db
      .prepare('UPDATE oauth_grants SET revoked=? WHERE id=? AND principal=?')
      .run(now(), id, principal).changes;
  }
  private revokeGrantForToken(id: string): void {
    this.db.prepare('UPDATE oauth_grants SET revoked=? WHERE id=?').run(now(), id);
  }
  revokePrincipal(principal: string): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE oauth_grants SET revoked=? WHERE principal=? AND revoked IS NULL')
        .run(now(), principal);
      this.db.prepare('DELETE FROM oauth_codes WHERE principal=?').run(principal);
    });
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
