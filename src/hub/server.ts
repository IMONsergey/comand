import express, { type Express, type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { HubError, HubStore, hashToken } from './store.js';
import { VERSION, type Overview, type SessionInfo } from '../shared/protocol.js';
export { HubStore } from './store.js';
export interface HubOptions {
  dataDir: string;
  adminToken: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  webDir?: string;
}
export interface HubAuth {
  isOwnerBearer(req: Request): boolean;
  isOwner(req: Request): boolean;
  requireOwner: RequestHandler;
  validateCsrf(req: Request): boolean;
}
export interface HubRuntime {
  app: Express;
  store: HubStore;
  auth: HubAuth;
  start(): Promise<string>;
  close(): Promise<void>;
}
interface Session {
  csrfToken: string;
  expires: number;
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
  const sessions = new Map<string, Session>();
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
  const sessionFor = (req: Request): Session | undefined => {
    const id = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('comand_session='))
      ?.slice('comand_session='.length);
    if (!id) return;
    const session = sessions.get(hashToken(id));
    if (session && session.expires > Date.now()) return session;
    if (session) sessions.delete(hashToken(id));
  };
  const auth: HubAuth = {
    isOwnerBearer: validBearer,
    isOwner(req) {
      return validBearer(req) || !!sessionFor(req);
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
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => {
    const session = sessionFor(req);
    const body: SessionInfo = {
      authenticated: auth.isOwner(req),
      ...(session ? { csrfToken: session.csrfToken } : {}),
    };
    res.json(body);
  });
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
  app.post('/api/login', rateLimit, (req, res) => {
    if (!sameOrigin(req, false)) {
      res.status(403).json({ error: 'Foreign login origin rejected', code: 'origin_rejected' });
      return;
    }
    if (
      typeof req.body?.token !== 'string' ||
      req.body.token.length > 1024 ||
      !safeEqual(req.body.token, options.adminToken)
    ) {
      res.status(401).json({ error: 'Invalid owner token', code: 'unauthorized' });
      return;
    }
    for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    const sessionId = randomBytes(32).toString('base64url');
    const session: Session = {
      csrfToken: randomBytes(32).toString('base64url'),
      expires: Date.now() + 12 * 60 * 60000,
    };
    sessions.set(hashToken(sessionId), session);
    res.cookie('comand_session', sessionId, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60000,
    });
    res.json({ authenticated: true, csrfToken: session.csrfToken } satisfies SessionInfo);
  });
  app.post('/api/logout', auth.requireOwner, (req, res) => {
    const id = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('comand_session='))
      ?.slice('comand_session='.length);
    if (id) sessions.delete(hashToken(id));
    res.clearCookie('comand_session', {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
    });
    res.json({ authenticated: false } satisfies SessionInfo);
  });
  app.post('/api/agent/enroll', rateLimit, (req, res) =>
    res.status(201).json(store.enroll(req.body)),
  );
  const requireDevice: RequestHandler = (req, res, next) => {
    const token = bearer(req);
    const id = token ? store.authenticateDevice(token) : null;
    if (!id) {
      res.status(401).json({ error: 'Valid device credentials required', code: 'unauthorized' });
      return;
    }
    res.locals.deviceId = id;
    next();
  };
  app.post('/api/agent/poll', requireDevice, (_req, res) =>
    res.json(store.poll(res.locals.deviceId as string)),
  );
  app.post('/api/agent/jobs/:id/update', requireDevice, (req, res) => {
    if (req.body?.jobId && req.body.jobId !== req.params.id)
      throw new HubError(400, 'URL and payload job IDs disagree');
    res.json(store.updateJob(res.locals.deviceId as string, { ...req.body, jobId: req.params.id }));
  });
  app.get('/api/overview', auth.requireOwner, (_req, res) => {
    const devices = store.listDevices(),
      projects = store.listProjects(),
      jobs = store.listJobs(),
      counts = store.getJobCounts();
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
  app.get('/api/devices', auth.requireOwner, (_req, res) => res.json(store.listDevices()));
  app.post('/api/pairings', auth.requireOwner, (_req, res) =>
    res.status(201).json(store.createPairing()),
  );
  app.post('/api/devices/:id/revoke', auth.requireOwner, (req, res) =>
    res.json(store.revokeDevice(req.params.id as string)),
  );
  app.get('/api/projects', auth.requireOwner, (_req, res) => res.json(store.listProjects()));
  app.post('/api/projects', auth.requireOwner, (req, res) =>
    res.status(201).json(store.createProject(req.body)),
  );
  app.patch('/api/projects/:id', auth.requireOwner, (req, res) =>
    res.json(store.updateProject(req.params.id as string, req.body)),
  );
  app.get('/api/jobs', auth.requireOwner, (_req, res) => res.json(store.listJobs()));
  app.post('/api/jobs', auth.requireOwner, (req, res) => {
    const existing =
      typeof req.body?.idempotencyKey === 'string'
        ? store.findJobByIdempotencyKey(req.body.idempotencyKey)
        : undefined;
    const job = store.createJob(req.body);
    res.status(existing ? 200 : 201).json(job);
  });
  app.get('/api/jobs/:id', auth.requireOwner, (req, res) => {
    const job = store.getJob(req.params.id as string);
    if (!job) throw new HubError(404, 'Job not found', 'not_found');
    res.json(job);
  });
  app.post('/api/jobs/:id/cancel', auth.requireOwner, (req, res) =>
    res.json(store.cancelJob(req.params.id as string)),
  );
  app.get('/api/jobs/:id/logs', auth.requireOwner, (req, res) =>
    res.json(
      store.getLogs(
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
      sessions.clear();
      store.close();
    },
  };
}
