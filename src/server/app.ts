import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import { readConfig } from './config.js';
import type { Db } from './db.js';
import { openDatabase } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { registerTeamRoutes } from './teams.js';
import { registerContentRoutes } from './content.js';
import { HttpError, unauthorized } from './errors.js';
import { authenticateAgentToken, authorizeAgentRoute } from './agentAuth.js';
import { registerAgentCredentialRoutes } from './agentTokens.js';
import { createTeamShelfMcpHandler } from './mcp.js';
import { registerMailRoutes } from './mail.js';
import { registerAccessExplainRoutes } from './accessExplain.js';
import { registerProposalRoutes } from './proposals.js';
import { registerCollaborationRoutes } from './collaboration.js';
import { registerCommentRoutes } from './comments.js';
import { registerWorkflowRoutes } from './workflow.js';
import { registerExternalRoomRoutes } from './rooms.js';
import type { MailSender } from './mailer.js';

export interface CreateAppOptions {
  config?: AppConfig;
  db?: Db;
  logger?: boolean;
  serveClient?: boolean;
  mailSender?: MailSender;
}

export function createApp(options: CreateAppOptions = {}): ReturnType<typeof Fastify> {
  const config = options.config ?? readConfig();
  const db = options.db ?? openDatabase(config.dataDir);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 500 * 1024,
    trustProxy: false,
  });

  app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  app.register(cookie);
  app.register(rateLimit, { global: true, max: 600, timeWindow: 60_000 });
  app.register(helmet, {
    frameguard: { action: 'deny' },
    hsts: config.appOrigin.startsWith('https://') ? { maxAge: 31_536_000 } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", new URL(config.appOrigin).protocol === 'https:' ? `wss://${new URL(config.appOrigin).host}` : `ws://${new URL(config.appOrigin).host}`],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        'upgrade-insecure-requests': null,
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.appOrigin) {
      throw new HttpError(403, 'ORIGIN_REJECTED', '请求来源不允许。');
    }
    const authorization = request.headers.authorization;
    const isAgent = authorization !== undefined;
    if (isAgent) {
      if (!authorization.startsWith('Bearer ') || request.headers.cookie !== undefined) throw unauthorized();
      const principal = authenticateAgentToken(db, authorization.slice('Bearer '.length));
      request.agentPrincipal = principal;
      authorizeAgentRoute(db, principal, request.routeOptions.config.agentAccess, request.params);
    }
    if (!isAgent && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-requested-with'] !== 'TeamShelf') {
        throw new HttpError(403, 'CSRF_REJECTED', '请求校验失败。');
      }
    }
  });
  app.addHook('preHandler', async (request) => {
    if (!request.agentPrincipal) return;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || request.headers.cookie !== undefined) throw unauthorized();
    const principal = authenticateAgentToken(db, authorization.slice('Bearer '.length));
    request.agentPrincipal = principal;
    authorizeAgentRoute(db, principal, request.routeOptions.config.agentAccess, request.params);
  });
  app.addHook('onResponse', async (request, reply) => {
    const principal = request.agentPrincipal;
    if (!principal) return;
    try {
      const policy = request.routeOptions.config.agentAccess;
      const params = request.params as Record<string, unknown>;
      const targetType = policy?.documentParam ? 'document' : policy?.spaceParam ? 'space' : 'team';
      const targetId = (policy?.documentParam && params[policy.documentParam])
        ?? (policy?.spaceParam && params[policy.spaceParam])
        ?? (policy?.teamParam && params[policy.teamParam])
        ?? (request.url.startsWith('/mcp') ? undefined : principal.spaceId)
        ?? principal.teamId;
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), principal.teamId, principal.userId,
        `agent.${request.url.startsWith('/mcp') ? 'mcp.call' : policy?.operation ?? 'blocked.route'}`, targetType, typeof targetId === 'string' ? targetId : null,
        new Date().toISOString(), JSON.stringify({ credentialId: principal.credentialId, route: request.routeOptions.url, method: request.method, statusCode: reply.statusCode }));
    } catch { /* Keep audit failures from changing an already-produced response. */ }
  });  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp')) reply.header('cache-control', 'no-store');
    if (request.url.startsWith('/share/') || request.url.startsWith('/api/share/')) reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' } });
    }
    if ((error as { name?: string }).name === 'ZodError' || statusCode === 400) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: '请求内容格式无效。' } });
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const code = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
      const message = statusCode === 413 ? '请求内容超过大小限制。' : statusCode === 404 ? '资源不存在或不可访问。' : '请求无法处理。';
      return reply.code(statusCode).send({ error: { code, message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求。' } });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.register(async (api) => {
    const context = { db, config, mailSender: options.mailSender };
    registerAuthRoutes(api, context);
    registerTeamRoutes(api, context);
    registerContentRoutes(api, context);
    registerAgentCredentialRoutes(api, context);
    registerMailRoutes(api, context);
    registerAccessExplainRoutes(api, context);
    registerProposalRoutes(api, context);
    registerCollaborationRoutes(api, context);
    registerCommentRoutes(api, context);
    registerWorkflowRoutes(api, context);
    registerExternalRoomRoutes(api, context);
  }, { prefix: '/api' });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (request, reply) => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    const authorization = request.headers.authorization;
    if (origin !== undefined && origin !== config.appOrigin) throw new HttpError(403, 'ORIGIN_REJECTED', '请求来源不允许。');
    if (request.headers.cookie !== undefined || !authorization?.startsWith('Bearer ') || authorization.length <= 7) throw unauthorized();
    if (!host) throw new HttpError(400, 'INVALID_HOST', '请求主机无效。');
    let hostname: string;
    try { const hostUrl = new URL('http://' + host); if (hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash) throw new Error('invalid host'); hostname = hostUrl.hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
    catch { throw new HttpError(400, 'INVALID_HOST', '请求主机无效。'); }
    const configuredHost = config.appOrigin ? new URL(config.appOrigin).hostname.toLowerCase().replace(/^\[|\]$/g, '') : '';
    if (hostname !== configuredHost && !['localhost', '127.0.0.1', '::1'].includes(hostname)) throw new HttpError(403, 'HOST_REJECTED', '请求主机不允许。');
    const token = authorization.slice(7);
    const principal = authenticateAgentToken(db, token);
    request.agentPrincipal = principal;
    const handler = createTeamShelfMcpHandler({ app, config, principal, token });
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string' && key.toLowerCase() !== 'content-length' && key.toLowerCase() !== 'cookie') headers.set(key, value);
    }
    const body = request.method === 'GET' ? undefined : request.body === undefined ? undefined : JSON.stringify(request.body);
    const webRequest = new Request(`http://${host}${request.url}`, { method: request.method, headers, body });
    const response = await handler.fetch(webRequest);
    response.headers.forEach((value, key) => reply.header(key, value));
    reply.header('cache-control', 'no-store');
    const responseBody = Buffer.from(await response.arrayBuffer());
    return reply.code(response.status).send(responseBody);
  }});
  const serveClient = options.serveClient ?? config.isProduction;
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在或不可访问。' } });
    }
    if (serveClient) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '页面不存在。' } });
  });
  if (serveClient) {
    app.register(fastifyStatic, {
      root: path.resolve(process.cwd(), 'dist/client'),
      prefix: '/',
      decorateReply: true,
    });
  }
  app.addHook('onClose', async () => {
    if (!options.db) db.close();
  });
  return app;
}
