import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
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
import { HttpError } from './errors.js';

export interface CreateAppOptions {
  config?: AppConfig;
  db?: Db;
  logger?: boolean;
  serveClient?: boolean;
}

export function createApp(options: CreateAppOptions = {}): ReturnType<typeof Fastify> {
  const config = options.config ?? readConfig();
  const db = options.db ?? openDatabase(config.dataDir);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 500 * 1024,
    trustProxy: false,
  });

  app.register(cookie);
  app.register(rateLimit, { global: true, max: 120, timeWindow: 60_000 });
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
        connectSrc: ["'self'"],
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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-requested-with'] !== 'TeamShelf') {
        throw new HttpError(403, 'CSRF_REJECTED', '请求校验失败。');
      }
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
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
    const context = { db, config };
    registerAuthRoutes(api, context);
    registerTeamRoutes(api, context);
    registerContentRoutes(api, context);
  }, { prefix: '/api' });
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
