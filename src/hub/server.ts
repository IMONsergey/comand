import express, { type Express, type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { HubError, HubStore, hashToken } from './store.js';
import { AccountsStore, OWNER, SESSION_LIFETIME } from './accounts.js';
import { installDistribution } from '../distribution.js';
import { VERSION, type Overview, type SessionInfo } from '../shared/protocol.js';
export { HubStore } from './store.js';
export interface HubOptions {
  dataDir: string;
  adminToken: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  webDir?: string;
  registrationEnabled?: boolean;
  distributionDir?: string;
}
export interface HubAuth {
  principal(req: Request): string | undefined;
  authenticateCredentials(input: unknown): Promise<string | undefined>;
  credentialVersion(principal: string): number | undefined;
  onCredentialsChanged(listener: (principal: string) => void): () => void;
  isOwnerBearer(req: Request): boolean;
  isOwner(req: Request): boolean;
  requireOwner: RequestHandler;
  validateCsrf(req: Request): boolean;
}
export interface HubRuntime {
  app: Express;
  store: HubStore;
  storeFor(principal: string): HubStore;
  auth: HubAuth;
  start(): Promise<string>;
  close(): Promise<void>;
}
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hashToken(a)), Buffer.from(hashToken(b)));
const bearer = (req: Request) => {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
};
const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
export async function createHub(options: HubOptions): Promise<HubRuntime> {
  if (options.adminToken.length < 32 || new Set(options.adminToken).size < 10)
    throw new Error(
      'Admin token must be at least 32 characters with high entropy. Generate one with crypto.randomBytes(32).toString("base64url").',
    );
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4310;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid hub port');
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined;
  if (
    publicUrl &&
    (publicUrl.username ||
      publicUrl.password ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.pathname !== '/')
  )
    throw new Error('publicUrl must be an origin without a path, credentials, query or fragment');
  if (
    publicUrl &&
    publicUrl.protocol !== 'https:' &&
    !(publicUrl.protocol === 'http:' && loopback(publicUrl.hostname))
  )
    throw new Error('Public hub URL must use HTTPS');
  if (!loopback(host) && (!publicUrl || publicUrl.protocol !== 'https:'))
    throw new Error('Non-loopback binding requires an explicit HTTPS publicUrl');
  const secure = publicUrl?.protocol === 'https:';
  const app = express();
  app.disable('x-powered-by');
  // A local reverse proxy must overwrite X-Forwarded-For with its actual peer.
  // Trust only that direct hop, never public peers or an arbitrary forwarded chain.
  app.set(
    'trust proxy',
    (address: string, hop: number) =>
      hop === 0 && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address),
  );
  const store = new HubStore(options.dataDir, options.adminToken);
  const accounts = new AccountsStore(options.dataDir);
  const stores = new Map<string, HubStore>([[OWNER, store]]);
  const credentialListeners = new Set<(principal: string) => void>();
  const registrationEnabled = options.registrationEnabled ?? true;
  const storeFor = (principal: string): HubStore => {
    if (principal !== OWNER && (!/^[a-f0-9-]{36}$/.test(principal) || !accounts.user(principal)))
      throw new HubError(401, 'Invalid account', 'unauthorized');
    let selected = stores.get(principal);
    if (!selected) {
      selected = new HubStore(join(options.dataDir, 'accounts', principal), options.adminToken);
      stores.set(principal, selected);
    }
    return selected;
  };
  let server: Server | undefined;
  const originFor = (req: Request) =>
    publicUrl?.origin ??
    `http://${host === '::1' ? '[::1]' : host}:${req.socket.localPort ?? port}`;
  const sameOrigin = (req: Request, required: boolean) => {
    const origin = req.get('origin');
    return origin ? origin === originFor(req) : !required;
  };
  const validBearer = (req: Request) => {
    const token = bearer(req);
    return !!token && safeEqual(token, options.adminToken);
  };
  const sessionIdFor = (req: Request) =>
    req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('comand_session='))
      ?.slice('comand_session='.length);
  const csrfFor = (id: string) =>
    createHmac('sha256', options.adminToken).update(`comand:csrf:${id}`).digest('base64url');
  const sessionFor = (req: Request) => {
    const id = sessionIdFor(req);
    const session = id ? accounts.session(id) : undefined;
    return session && id ? { ...session, csrfToken: csrfFor(id) } : undefined;
  };
  const auth: HubAuth = {
    principal(req) {
      return validBearer(req) ? OWNER : sessionFor(req)?.principal;
    },
    authenticateCredentials: (input) => accounts.authenticate(input),
    credentialVersion: (principal) => accounts.version(principal),
    onCredentialsChanged(listener) {
      credentialListeners.add(listener);
      return () => {
        credentialListeners.delete(listener);
      };
    },
    isOwnerBearer: validBearer,
    isOwner(req) {
      return auth.principal(req) !== undefined;
    },
    validateCsrf(req) {
      if (validBearer(req)) return true;
      const session = sessionFor(req);
      const csrf = req.get('x-comand-csrf');
      return !!session && !!csrf && sameOrigin(req, true) && safeEqual(csrf, session.csrfToken);
    },
    requireOwner(req, res, next) {
      if (!auth.isOwner(req)) {
        res.status(401).json({ error: 'Authentication required', code: 'unauthorized' });
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !auth.validateCsrf(req)) {
        res
          .status(403)
          .json({ error: 'A valid same-origin CSRF token is required', code: 'csrf_failed' });
        return;
      }
      next();
    },
  };
  app.use((req, res, next) => {
    const localPort = req.socket.localPort ?? port;
    const allowedHosts = new Set([
      ...(publicUrl ? [publicUrl.host] : []),
      ...['127.0.0.1', 'localhost', '[::1]', host === '::1' ? '[::1]' : host].map(
        (h) => `${h}:${localPort}`,
      ),
    ]);
    if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase())) {
      res.status(403).json({ error: 'Unrecognized request host', code: 'invalid_host' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '5mb', strict: true }));
  installDistribution(app, { directory: options.distributionDir });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const sessionInfo = (req: Request): SessionInfo => {
    const session = sessionFor(req);
    const principal = auth.principal(req);
    return {
      authenticated: principal !== undefined,
      registrationEnabled,
      ...(session ? { csrfToken: session.csrfToken } : {}),
      ...(principal && accounts.user(principal) ? { user: accounts.user(principal) } : {}),
    };
  };
  const setSession = (res: express.Response, principal: string): SessionInfo => {
    const session = accounts.createSession(principal);
    res.cookie('comand_session', session.id, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_LIFETIME,
    });
    return {
      authenticated: true,
      registrationEnabled,
      csrfToken: csrfFor(session.id),
      ...(accounts.user(principal) ? { user: accounts.user(principal) } : {}),
    };
  };
  const credentialsChanged = (principal: string) => {
    for (const listener of credentialListeners) listener(principal);
  };
  app.get('/api/session', (req, res) => res.json(sessionInfo(req)));
  const attempts = new Map<
    string,
    {
      count: number;
      reset: number;
    }
  >();
  const rateLimit: RequestHandler = (req, res, next) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'local';
    const existing = attempts.get(key);
    const record =
      existing && existing.reset > Date.now() ? existing : { count: 0, reset: Date.now() + 60000 };
    record.count++;
    attempts.set(key, record);
    if (attempts.size > 10000) {
      for (const [address, entry] of attempts)
        if (entry.reset < Date.now()) attempts.delete(address);
      if (attempts.size > 10000) attempts.delete(attempts.keys().next().value!);
    }
    if (record.count > 30) {
      res.status(429).json({
        error: 'Too many authentication attempts. Try again shortly.',
        code: 'rate_limited',
      });
      return;
    }
    next();
  };
  const accountAttempts = new Map<string, { count: number; reset: number }>();
  const publicAuth: RequestHandler = (req, res, next) => {
    if (!sameOrigin(req, false)) {
      res
        .status(403)
        .json({ error: 'Foreign authentication origin rejected', code: 'origin_rejected' });
      return;
    }
    if (typeof req.body?.email === 'string') {
      const key = hashToken(req.body.email.trim().toLowerCase());
      const old = accountAttempts.get(key);
      const attempt = old && old.reset > Date.now() ? old : { count: 0, reset: Date.now() + 60000 };
      attempt.count++;
      accountAttempts.set(key, attempt);
      if (accountAttempts.size > 10000)
        accountAttempts.delete(accountAttempts.keys().next().value!);
      if (attempt.count > 12) {
        res.status(429).json({
          error: 'Too many authentication attempts. Try again shortly.',
          code: 'rate_limited',
        });
        return;
      }
    }
    next();
  };
  app.post('/api/login', rateLimit, publicAuth, async (req, res) => {
    const principal =
      typeof req.body?.token === 'string' &&
      req.body.token.length <= 1024 &&
      safeEqual(req.body.token, options.adminToken)
        ? OWNER
        : await accounts.authenticate(req.body);
    if (!principal) throw new HubError(401, 'Invalid credentials', 'invalid_credentials');
    const previous = sessionIdFor(req);
    if (previous) accounts.deleteSession(previous);
    res.json(setSession(res, principal));
  });
  app.post('/api/register', rateLimit, publicAuth, async (req, res) => {
    if (!registrationEnabled)
      throw new HubError(403, 'Registration is disabled', 'registration_disabled');
    const result = await accounts.register(req.body);
    res
      .status(201)
      .json({ ...setSession(res, result.principal), recoveryCode: result.recoveryCode });
  });
  app.post('/api/recover', rateLimit, publicAuth, async (req, res) => {
    const result = await accounts.recover(req.body);
    credentialsChanged(result.principal);
    res.json({ ...setSession(res, result.principal), recoveryCode: result.recoveryCode });
  });
  app.get('/api/account', auth.requireOwner, (req, res) => res.json(sessionInfo(req)));
  app.post('/api/account/password', auth.requireOwner, rateLimit, async (req, res) => {
    const principal = auth.principal(req)!;
    await accounts.changePassword(principal, req.body);
    credentialsChanged(principal);
    res.json(setSession(res, principal));
  });
  app.post('/api/account/claim', auth.requireOwner, rateLimit, async (req, res) => {
    if (auth.principal(req) !== OWNER)
      throw new HubError(403, 'Only the legacy owner may claim this workspace', 'forbidden');
    const result = await accounts.register(req.body, true);
    res
      .status(201)
      .json({ ...setSession(res, result.principal), recoveryCode: result.recoveryCode });
  });
  app.post('/api/logout', auth.requireOwner, (req, res) => {
    const id = sessionIdFor(req);
    if (id) accounts.deleteSession(id);
    res.clearCookie('comand_session', { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    res.json({ authenticated: false, registrationEnabled } satisfies SessionInfo);
  });
  app.post('/api/agent/enroll', rateLimit, (req, res) => {
    if (typeof req.body?.pairingCode !== 'string' || req.body.pairingCode.length > 100)
      throw new HubError(400, 'A valid pairing code is required', 'invalid_request');
    // Unindexed codes belong only to pre-upgrade owner state, never a new user's store.
    const principal = accounts.pairingPrincipal(req.body.pairingCode) ?? OWNER;
    const credentials = storeFor(principal).enroll(req.body);
    accounts.mapDevice(credentials.token, principal, req.body.pairingCode);
    res.status(201).json(credentials);
  });
  const requireDevice: RequestHandler = (req, res, next) => {
    const token = bearer(req);
    const deviceStore =
      token && token.length <= 1024
        ? storeFor(accounts.devicePrincipal(token) ?? OWNER)
        : undefined;
    const id = token && deviceStore ? deviceStore.authenticateDevice(token) : null;
    if (!id) {
      res.status(401).json({ error: 'Valid device credentials required', code: 'unauthorized' });
      return;
    }
    res.locals.deviceId = id;
    res.locals.deviceStore = deviceStore;
    next();
  };
  app.post('/api/agent/poll', requireDevice, (_req, res) =>
    res.json((res.locals.deviceStore as HubStore).poll(res.locals.deviceId as string)),
  );
  app.post('/api/agent/jobs/:id/update', requireDevice, (req, res) => {
    if (req.body?.jobId && req.body.jobId !== req.params.id)
      throw new HubError(400, 'URL and payload job IDs disagree');
    res.json(
      (res.locals.deviceStore as HubStore).updateJob(res.locals.deviceId as string, {
        ...req.body,
        jobId: req.params.id,
      }),
    );
  });
  const requestStore = (req: Request) => storeFor(auth.principal(req)!);
  app.get('/api/overview', auth.requireOwner, (req, res) => {
    const devices = requestStore(req).listDevices(),
      projects = requestStore(req).listProjects(),
      jobs = requestStore(req).listJobs(),
      counts = requestStore(req).getJobCounts();
    const overview: Overview = {
      version: VERSION,
      devices,
      projects,
      jobs,
      counts: {
        devices: devices.length,
        online: devices.filter((d) => d.online).length,
        running: counts.running + counts.dispatched,
        queued: counts.queued,
        succeeded: counts.succeeded,
        failed: counts.failed,
        uncertain: counts.uncertain,
      },
    };
    res.json(overview);
  });
  app.get('/api/devices', auth.requireOwner, (req, res) =>
    res.json(requestStore(req).listDevices()),
  );
  app.post('/api/pairings', auth.requireOwner, (req, res) => {
    const pairing = requestStore(req).createPairing();
    accounts.mapPairing(pairing.code, auth.principal(req)!, pairing.expiresAt);
    res.status(201).json(pairing);
  });
  app.post('/api/devices/:id/revoke', auth.requireOwner, (req, res) =>
    res.json(requestStore(req).revokeDevice(req.params.id as string)),
  );
  app.get('/api/projects', auth.requireOwner, (req, res) =>
    res.json(requestStore(req).listProjects()),
  );
  app.post('/api/projects', auth.requireOwner, (req, res) =>
    res.status(201).json(requestStore(req).createProject(req.body)),
  );
  app.patch('/api/projects/:id', auth.requireOwner, (req, res) =>
    res.json(requestStore(req).updateProject(req.params.id as string, req.body)),
  );
  app.get('/api/jobs', auth.requireOwner, (req, res) => res.json(requestStore(req).listJobs()));
  app.post('/api/jobs', auth.requireOwner, (req, res) => {
    const existing =
      typeof req.body?.idempotencyKey === 'string'
        ? requestStore(req).findJobByIdempotencyKey(req.body.idempotencyKey)
        : undefined;
    const job = requestStore(req).createJob(req.body);
    res.status(existing ? 200 : 201).json(job);
  });
  app.get('/api/jobs/:id', auth.requireOwner, (req, res) => {
    const job = requestStore(req).getJob(req.params.id as string);
    if (!job) throw new HubError(404, 'Job not found', 'not_found');
    res.json(job);
  });
  app.post('/api/jobs/:id/cancel', auth.requireOwner, (req, res) =>
    res.json(requestStore(req).cancelJob(req.params.id as string)),
  );
  app.get('/api/jobs/:id/logs', auth.requireOwner, (req, res) =>
    res.json(
      requestStore(req).getLogs(
        req.params.id as string,
        req.query.offset === undefined ? 0 : Number(req.query.offset),
        req.query.limit === undefined ? 65536 : Number(req.query.limit),
      ),
    ),
  );
  app.use('/api', (req, res, next) => {
    if (req.path === '/connections' || req.path.startsWith('/connections/')) {
      next();
      return;
    }
    res.status(404).json({ error: 'API route not found', code: 'not_found' });
  });
  const webDir = resolve(options.webDir ?? join(process.cwd(), 'dist/web'));
  if (existsSync(join(webDir, 'index.html'))) {
    const staticHandler = express.static(webDir, { index: false, dotfiles: 'deny' });
    app.use((req, res, next) => {
      if (/^\/(?:mcp|oauth|\.well-known)(?:\/|$)/.test(req.path)) {
        next();
        return;
      }
      staticHandler(req, res, next);
    });
    app.get(/^\/(?:jobs(?:\/[^/]+)?|projects|devices|settings)?\/?$/, (req, res) =>
      res.sendFile(join(webDir, 'index.html')),
    );
  }
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HubError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error.status === 400 || error.status === 413)
    ) {
      res.status(error.status as number).json({
        error: error.status === 413 ? 'Request body is too large' : 'Invalid JSON request',
        code: 'invalid_request',
      });
      return;
    }
    console.error('Hub request failed', error);
    res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
  });
  return {
    app,
    store,
    storeFor,
    auth,
    async start() {
      if (server) {
        const addr = server.address();
        return (
          publicUrl?.origin ??
          `http://${host === '::1' ? '[::1]' : host}:${typeof addr === 'object' && addr ? addr.port : port}`
        );
      }
      await new Promise<void>((resolveStart, reject) => {
        server = app.listen(port, host, (error?: Error) =>
          error ? reject(error) : resolveStart(),
        );
        server.once('error', reject);
      });
      const addr = server!.address();
      return (
        publicUrl?.origin ??
        `http://${host === '::1' ? '[::1]' : host}:${typeof addr === 'object' && addr ? addr.port : port}`
      );
    },
    async close() {
      if (server) {
        const closing = server;
        server = undefined;
        await new Promise<void>((resolveClose, reject) => {
          closing.close((error) =>
            error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? reject(error)
              : resolveClose(),
          );
          closing.closeIdleConnections();
        });
      }
      credentialListeners.clear();
      accounts.close();
      for (const workspace of stores.values()) workspace.close();
    },
  };
}
