import express, { type Request, type Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HubRuntime } from '../hub/server.js';
import { OAuthProvider, SCOPES, type PendingAuthorization } from './oauth-provider.js';
import { createMcpServer } from './tools.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const cookieValue = (req: Request, name: string) =>
  req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const safeMatch = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function consentHtml(
  request: PendingAuthorization,
  csrf: string,
  loggedIn: boolean,
  error = '',
): string {
  const labels: Record<string, string> = {
    'comand:read': 'Просмотр устройств, проектов, файлов и результатов',
    'comand:write': 'Изменение файлов и заметок проектов',
    'comand:execute': 'Запуск и остановка команд на разрешённых устройствах',
  };
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение к Comand</title><style>body{margin:0;background:#f4f5f1;color:#202521;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{background:white;width:min(480px,calc(100% - 64px));padding:32px;border:1px solid #dce0d7;border-radius:20px}h1{font-size:28px;line-height:1.2}p,li{color:#596156}ul{padding-left:20px}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bcc5b7;border-radius:8px;font:inherit}button{padding:12px 18px;border:1px solid #222b22;border-radius:8px;background:#d9f196;font:inherit;cursor:pointer;margin:20px 8px 0 0}button[value=deny]{background:white}small{overflow-wrap:anywhere}.error{color:#ab2525}</style><main><strong>comand / подключение</strong><h1>Разрешить доступ<br>${escapeHtml(request.clientName)}?</h1><p>Подключение получит следующие возможности:</p><ul>${request.scopes.map((s) => `<li>${escapeHtml(labels[s] ?? s)}</li>`).join('')}</ul><p><small>Адрес возврата: ${escapeHtml(request.redirectUri)}</small></p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${escapeHtml(request.id)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${loggedIn ? '<p>Вы вошли как владелец.</p>' : '<label for="token">Ключ владельца Comand</label><input id="token" name="token" type="password" autocomplete="off" required><small>Ключ хранится на компьютере, где работает сервер Comand.</small>'}<button name="decision" value="allow">Подключить</button><button name="decision" value="deny" formnovalidate>Отмена</button></form></main></html>`;
}

export function installMcp(hub: HubRuntime, options: { dataDir: string; publicUrl: string }) {
  const origin = new URL(options.publicUrl).origin;
  const resource = new URL('/mcp', origin);
  const provider = new OAuthProvider(options.dataDir, resource);
  const app = hub.app;
  const csrfCookie = 'comand_oauth_csrf';
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      resourceServerUrl: resource,
      scopesSupported: SCOPES,
      resourceName: 'Comand',
    }),
  );
  const renderConsent = (
    req: Request,
    res: Response,
    request: PendingAuthorization,
    error = '',
  ) => {
    let csrf = cookieValue(req, csrfCookie);
    if (!csrf || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) csrf = randomBytes(32).toString('base64url');
    res.cookie(csrfCookie, csrf, {
      httpOnly: true,
      secure: resource.protocol === 'https:',
      sameSite: 'lax',
      path: '/oauth',
      maxAge: 600_000,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.type('html').send(consentHtml(request, csrf, hub.auth.isOwner(req), error));
  };
  app.get('/oauth/consent', (req, res) => {
    try {
      renderConsent(req, res, provider.getRequest(String(req.query.request ?? '')));
    } catch {
      res.status(400).type('text').send('Запрос подключения истёк. Начните подключение заново.');
    }
  });
  const consentAttempts = new Map<string, { count: number; until: number }>();
  app.post('/oauth/consent', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const peer = req.socket.remoteAddress ?? 'unknown';
    const previous = consentAttempts.get(peer);
    const limit =
      previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
    limit.count++;
    consentAttempts.set(peer, limit);
    if (limit.count > 20) {
      res.status(429).send('Слишком много попыток. Подождите минуту.');
      return;
    }
    const csrf = cookieValue(req, csrfCookie);
    if (
      req.get('origin') !== origin ||
      !csrf ||
      typeof req.body?.csrf !== 'string' ||
      !safeMatch(csrf, req.body.csrf)
    ) {
      res.status(403).send('Проверка запроса не пройдена. Откройте подключение заново.');
      return;
    }
    try {
      const request = provider.getRequest(String(req.body.request ?? ''));
      if (req.body.decision === 'deny') {
        res.redirect(303, provider.denyRequest(request.id));
        return;
      }
      if (req.body.decision !== 'allow') {
        res.status(400).send('Выберите действие');
        return;
      }
      if (
        !hub.auth.isOwner(req) &&
        typeof req.body.token === 'string' &&
        req.body.token.length <= 1024
      )
        req.headers.authorization = `Bearer ${req.body.token}`;
      if (!hub.auth.isOwner(req)) {
        res.status(401);
        renderConsent(req, res, request, 'Ключ владельца не подошёл.');
        return;
      }
      res.redirect(303, provider.approveRequest(request.id));
    } catch {
      res.status(400).send('Запрос подключения истёк или уже использован.');
    }
  });
  app.get('/api/connections', hub.auth.requireOwner, (_req, res) =>
    res.json(provider.listGrants()),
  );
  app.post('/api/connections/:id/revoke', hub.auth.requireOwner, (req, res) => {
    provider.revokeGrant(String(req.params.id));
    res.json({ revoked: true });
  });
  const oauthAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
    requiredScopes: [],
  });
  app.use('/mcp', (req, res, next) => {
    if (req.get('origin') && req.get('origin') !== origin) {
      res.status(403).json({ error: 'Foreign origin rejected' });
      return;
    }
    if (hub.auth.isOwnerBearer(req)) {
      req.auth = {
        token: '',
        clientId: 'owner',
        scopes: SCOPES,
        expiresAt: Date.now() / 1000 + 300,
        resource,
      };
      next();
    } else void oauthAuth(req, res, next);
  });
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(hub.store, req.auth?.scopes ?? []);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res
          .status(500)
          .json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'MCP request failed' },
          });
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res
      .status(405)
      .json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Use POST for stateless MCP' },
      });
  });
  return { provider, close: () => provider.close() };
}
