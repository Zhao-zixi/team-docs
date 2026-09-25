import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { transaction } from './db.js';
import { conflict, forbidden, unauthorized } from './errors.js';
import { expiresInDays, hashPassword, hashToken, isoNow, newToken, safeSecretEqual, verifyPassword } from './security.js';
import { validateBody } from './validation.js';

const SESSION_COOKIE = 'teamshelf_session';
export const SESSION_TTL_DAYS = 7;
const EmailSchema = z.string().trim().email().max(254);
const NameSchema = z.string().trim().min(1).max(80);
const PasswordSchema = z.string().min(12).max(128);
const SetupBodySchema = z.object({
  token: z.string().min(1).max(256), name: NameSchema, email: EmailSchema,
  password: PasswordSchema, teamName: NameSchema,
}).strict();
const LoginBodySchema = z.object({ email: EmailSchema, password: z.string().min(1).max(128) }).strict();
const PasswordChangeBodySchema = z.object({
  currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema,
}).strict();

interface AuthOptions {
  db: Db;
  config: AppConfig;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

function cookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

function cookieToken(request: FastifyRequest): string | undefined {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  return cookies?.[SESSION_COOKIE];
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(config));
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

export function createSession(db: Db, userId: string): string {
  const token = newToken();
  db.prepare('INSERT INTO sessions(id, token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(), hashToken(token), userId, isoNow(), expiresInDays(SESSION_TTL_DAYS));
  return token;
}

export function createSessionAfterPasswordCheck(db: Db, userId: string, verifiedHash: string): string {
  return transaction(db, () => {
    const latest = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string } | undefined;
    if (!latest || latest.password_hash !== verifiedHash) throw unauthorized();
    return createSession(db, userId);
  });
}

export function requireUserId(db: Db, request: FastifyRequest): string {
  const token = cookieToken(request);
  if (!token) throw unauthorized();
  const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), isoNow()) as { user_id: string } | undefined;
  if (!row) throw unauthorized();
  return row.user_id;
}

export function listUserTeams(db: Db, userId: string): Array<{ id: string; name: string; role: string }> {
  return db.prepare(`
    SELECT t.id, t.name, m.role
    FROM teams t JOIN members m ON m.team_id = t.id
    WHERE m.user_id = ? ORDER BY t.created_at, t.name
  `).all(userId) as Array<{ id: string; name: string; role: string }>;
}

export function registerAuthRoutes(app: FastifyInstance, { db, config }: AuthOptions): void {
  app.get('/setup', async () => ({ needsSetup: !db.prepare('SELECT 1 FROM users LIMIT 1').get() }));

  app.post('/setup', {
    config: { rateLimit: { max: 5, timeWindow: 60_000 } },
    preValidation: validateBody(SetupBodySchema),
  }, async (request, reply) => {
    const body = request.body as { token: string; name: string; email: string; password: string; teamName: string };
    if (!config.setupToken) throw forbidden('首次初始化未配置。');
    if (!safeSecretEqual(body.token, config.setupToken)) throw forbidden('初始化凭证无效。');
    const normalizedEmail = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);
    const userId = randomUUID();
    const teamId = randomUUID();
    const spaceId = randomUUID();
    const now = isoNow();
    const sessionToken = newToken();
    const teams = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw conflict('系统已完成初始化。');
      db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
        .run(userId, normalizedEmail, normalizedEmail, body.name.trim(), passwordHash, now);
      db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, body.teamName.trim(), now);
      db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, 'owner', now);
      db.prepare(`INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(spaceId, teamId, '团队知识库', '', 'team', userId, now);
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), teamId, userId, 'team.setup', 'team', teamId, now);
      db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(randomUUID(), hashToken(sessionToken), userId, now, expiresInDays(SESSION_TTL_DAYS));
      return listUserTeams(db, userId);
    });
    setSessionCookie(reply, config, sessionToken);
    return reply.code(201).send({ user: { id: userId, email: normalizedEmail, name: body.name.trim() }, teams });
  });

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    preValidation: validateBody(LoginBodySchema),
  }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const row = db.prepare('SELECT id,email,name,password_hash FROM users WHERE normalized_email=?')
      .get(body.email.trim().toLowerCase()) as UserRow | undefined;
    if (!row || !(await verifyPassword(body.password, row.password_hash))) throw unauthorized();
    const token = createSessionAfterPasswordCheck(db, row.id, row.password_hash);
    setSessionCookie(reply, config, token);
    return { user: { id: row.id, email: row.email, name: row.name }, teams: listUserTeams(db, row.id) };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = cookieToken(request);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const userId = requireUserId(db, request);
    const user = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(userId) as Omit<UserRow, 'password_hash'> | undefined;
    if (!user) throw unauthorized();
    return { user, teams: listUserTeams(db, userId) };
  });

  app.post('/auth/password', {
    preValidation: validateBody(PasswordChangeBodySchema),
  }, async (request, reply) => {
    const userId = requireUserId(db, request);
    const body = request.body as { currentPassword: string; newPassword: string };
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string } | undefined;
    if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) throw unauthorized();
    const nextHash = await hashPassword(body.newPassword);
    transaction(db, () => {
      const latest = db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string } | undefined;
      if (!latest || latest.password_hash !== user.password_hash) throw conflict('密码已在其他请求中更改，请重新登录。');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(nextHash, userId);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    });
    clearSessionCookie(reply, config);
    return { ok: true };
  });
}
