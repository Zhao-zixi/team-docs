import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { requireUserId } from './auth.js';
import { conflict, forbidden, notFound } from './errors.js';
import { assertMailEncryptionKey, encryptMailPassword, sendConfiguredMail, type MailSender, type OutgoingMail } from './mailer.js';
import { expiresInDays, hashToken, isoNow, newToken } from './security.js';
import { validateBody, validateParams } from './validation.js';

const MailSettingsBody = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  username: z.string().trim().min(1).max(254),
  fromEmail: z.string().trim().email().max(254),
  fromName: z.string().trim().min(1).max(100),
  password: z.string().max(512).optional(),
}).strict();
const InviteEmailBody = z.object({ email: z.string().trim().email().max(254), role: z.enum(['admin', 'editor', 'viewer']) }).strict();
const TeamParams = z.object({ teamId: z.string().uuid() }).strict();
const InviteParams = z.object({ teamId: z.string().uuid(), invitationId: z.string().uuid() }).strict();
const EmptyBody = z.object({}).strict();

function requireSessionUser(db: AppContext['db'], request: Parameters<typeof requireUserId>[1]): string {
  if (request.agentPrincipal) throw forbidden('此功能仅支持浏览器会话。');
  return requireUserId(db, request);
}

function requireAnyManager(db: AppContext['db'], userId: string): void {
  if (!db.prepare("SELECT 1 FROM members WHERE user_id=? AND role IN ('owner','admin') LIMIT 1").get(userId)) throw forbidden();
}

function requireTeamManager(db: AppContext['db'], teamId: string, userId: string, role?: string): 'owner' | 'admin' {
  const row = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: string } | undefined;
  if (!row || (row.role !== 'owner' && row.role !== 'admin')) throw forbidden();
  if (role === 'admin' && row.role !== 'owner') throw forbidden('只有所有者可以邀请管理员。');
  return row.role;
}

function removeStaleInvitations(db: AppContext['db'], teamId: string, email: string): void {
  const rows = db.prepare('SELECT id,role,created_by,expires_at FROM invitations WHERE team_id=? AND normalized_email=? AND used_at IS NULL').all(teamId,email) as Array<{id:string;role:'admin'|'editor'|'viewer';created_by:string;expires_at:string}>;
  for (const row of rows) {
    const creator = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId,row.created_by) as {role:string}|undefined;
    const allowed = row.role === 'admin' ? creator?.role === 'owner' : creator?.role === 'owner' || creator?.role === 'admin';
    if (row.expires_at <= isoNow() || !allowed) db.prepare('DELETE FROM invitations WHERE id=? AND used_at IS NULL').run(row.id);
  }
}

function invitationDto(db: AppContext['db'], invitationId: string) {
  const row = db.prepare(`SELECT id,email,role,created_at,expires_at,delivery_status,last_sent_at
    FROM invitations WHERE id=?`).get(invitationId) as {
      id: string; email: string; role: 'admin' | 'editor' | 'viewer'; created_at: string; expires_at: string;
      delivery_status: 'not_sent' | 'sending' | 'sent' | 'failed'; last_sent_at: string | null;
    } | undefined;
  if (!row) throw notFound();
  return {
    id: row.id, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at,
    deliveryStatus: row.delivery_status, lastSentAt: row.last_sent_at,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function sendInvitationMessage(
  sender: MailSender,
  db: AppContext['db'],
  dataDir: string,
  userId: string,
  to: string,
  teamName: string,
  token: string,
  appOrigin: string,
): Promise<void> {
  const url = `${appOrigin}/?invite=${encodeURIComponent(token)}`;
  if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('MAIL_ORIGIN_INVALID');
  const safeTeam = escapeHtml(teamName);
  const safeUrl = escapeHtml(url);
  const message: OutgoingMail = {
    to,
    subject: `加入「${teamName}」团队`,
    text: `你受邀加入「${teamName}」团队。打开此链接接受邀请（7天内有效）：${url}`,
    html: `<p>你受邀加入「${safeTeam}」团队。</p><p><a href="${safeUrl}">接受邀请</a>（7天内有效）</p>`,
  };
  await sender(db, dataDir, userId, message);
}

export function registerMailRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context;
  const sendMail = context.mailSender ?? sendConfiguredMail;

  app.get('/mail/settings', async (request) => {
    const userId = requireSessionUser(db, request);
    requireAnyManager(db, userId);
    const row = db.prepare(`SELECT host,port,security,username,from_email,from_name
      FROM mail_settings WHERE user_id=?`).get(userId) as {
        host: string; port: number; security: 'tls' | 'starttls'; username: string; from_email: string; from_name: string;
      } | undefined;
    return { configured: !!row, settings: row ? {
      host: row.host, port: row.port, security: row.security, username: row.username,
      fromEmail: row.from_email, fromName: row.from_name, hasPassword: true,
    } : null };
  });

  app.put('/mail/settings', { preValidation: validateBody(MailSettingsBody) }, async (request) => {
    const userId = requireSessionUser(db, request);
    const body = request.body as z.infer<typeof MailSettingsBody>;
    return transaction(db, () => {
      requireAnyManager(db, userId);
      const old = db.prepare('SELECT host,port,security,username,password_ciphertext,password_iv,password_tag FROM mail_settings WHERE user_id=?')
        .get(userId) as {host:string;port:number;security:'tls'|'starttls';username:string;password_ciphertext:string;password_iv:string;password_tag:string}|undefined;
      const password = body.password ?? '';
      let secret: {ciphertext:string;iv:string;tag:string};
      if (password.length > 0) secret = encryptMailPassword(db, config.dataDir, userId, password);
      else if (old) {
        const sameAuthTarget = old.host === body.host && old.port === body.port && old.security === body.security && old.username === body.username;
        if (!sameAuthTarget) throw forbidden('修改邮件服务器或登录账号时必须重新输入邮箱密码。');
        assertMailEncryptionKey(db, config.dataDir);
        secret = {ciphertext:old.password_ciphertext,iv:old.password_iv,tag:old.password_tag};
      } else throw forbidden('首次配置必须填写邮箱密码。');
      const now = isoNow();
      db.prepare('INSERT INTO mail_settings(user_id,host,port,security,username,from_email,from_name,password_ciphertext,password_iv,password_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET host=excluded.host,port=excluded.port,security=excluded.security,username=excluded.username,from_email=excluded.from_email,from_name=excluded.from_name,password_ciphertext=excluded.password_ciphertext,password_iv=excluded.password_iv,password_tag=excluded.password_tag,updated_at=excluded.updated_at')
        .run(userId, body.host, body.port, body.security, body.username, body.fromEmail, body.fromName, secret.ciphertext, secret.iv, secret.tag, now, now);
      return {configured:true,settings:{host:body.host,port:body.port,security:body.security,username:body.username,fromEmail:body.fromEmail,fromName:body.fromName,hasPassword:true}};
    });
  });

  app.delete('/mail/settings', async (request) => {
    const userId = requireSessionUser(db, request);
    db.prepare('DELETE FROM mail_settings WHERE user_id=?').run(userId);
    return { ok: true };
  });

  app.post('/mail/settings/test', {
    preValidation: validateBody(EmptyBody),
    config: { rateLimit: { max: 5, timeWindow: 60_000 } },
  }, async (request) => {
    const userId = requireSessionUser(db, request);
    requireAnyManager(db, userId);
    const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string } | undefined;
    if (!user) throw notFound();
    try {
      await sendMail(db, config.dataDir, userId, { to: user.email, subject: 'TeamShelf 邮件配置测试', text: '邮件配置测试成功。' });
      return { sent: true, to: user.email };
    } catch {
      return { sent: false, to: user.email, error: '邮件发送失败，请检查配置和服务商状态。' };
    }
  });

  app.post('/teams/:teamId/invitations/email', {
    preValidation: [validateParams(TeamParams), validateBody(InviteEmailBody)],
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const userId = requireSessionUser(db, request);
    const { teamId } = request.params as z.infer<typeof TeamParams>;
    const body = request.body as z.infer<typeof InviteEmailBody>;
    const email = body.email.trim().toLowerCase();
    const invite = transaction(db, () => {
      requireTeamManager(db, teamId, userId, body.role);
      removeStaleInvitations(db, teamId, email);
      if (db.prepare('SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.normalized_email=?')
        .get(teamId, email)) throw conflict('该邮箱已是团队成员。');
      if (db.prepare(`SELECT 1 FROM invitations WHERE team_id=? AND normalized_email=? AND used_at IS NULL AND expires_at>?`)
        .get(teamId, email, isoNow())) throw conflict('该邮箱已有待处理邀请。');
      const team = db.prepare('SELECT name FROM teams WHERE id=?').get(teamId) as { name: string } | undefined;
      if (!team) throw notFound();
      const id = randomUUID();
      const token = newToken();
      const createdAt = isoNow();
      const expiresAt = expiresInDays(7);
      db.prepare(`INSERT INTO invitations(id,team_id,email,normalized_email,role,token_hash,created_by,created_at,expires_at,delivery_status,send_generation)
        VALUES(?,?,?,?,?,?,?,?,?,'sending',1)`).run(id, teamId, email, email, body.role, hashToken(token), userId, createdAt, expiresAt);
      return { id, token, email, teamName: team.name, generation: 1 };
    });
    let delivery: 'sent' | 'failed' = 'failed';
    try {
      await sendInvitationMessage(sendMail, db, config.dataDir, userId, invite.email, invite.teamName, invite.token, config.appOrigin);
      delivery = 'sent';
    } catch { /* The failed state is recorded without exposing provider details. */ }
    transaction(db, () => {
      db.prepare(`UPDATE invitations SET delivery_status=?,last_sent_at=? WHERE id=? AND send_generation=? AND used_at IS NULL`)
        .run(delivery, delivery === 'sent' ? isoNow() : null, invite.id, invite.generation);
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), teamId, userId, 'invitation.email', 'invitation', invite.id, isoNow(), JSON.stringify({ delivery }));
    });
    return reply.code(201).send({ invitation: invitationDto(db, invite.id), delivery });
  });

  app.post('/teams/:teamId/invitations/:invitationId/send', {
    preValidation: validateParams(InviteParams),
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request) => {
    const userId = requireSessionUser(db, request);
    const { teamId, invitationId } = request.params as z.infer<typeof InviteParams>;
    const token = newToken();
    const invite = transaction(db, () => {
      const row = db.prepare(`SELECT i.email,i.role,i.expires_at,i.used_at,t.name AS team_name
        FROM invitations i JOIN teams t ON t.id=i.team_id WHERE i.id=? AND i.team_id=?`).get(invitationId, teamId) as {
          email: string; role: 'admin' | 'editor' | 'viewer'; expires_at: string; used_at: string | null; team_name: string;
        } | undefined;
      if (!row || row.used_at || row.expires_at <= isoNow()) throw notFound();
      requireTeamManager(db, teamId, userId, row.role);
      const generation = Number((db.prepare('SELECT send_generation FROM invitations WHERE id=?').get(invitationId) as { send_generation: number }).send_generation) + 1;
      const update = db.prepare(`UPDATE invitations SET token_hash=?,created_by=?,delivery_status='sending',send_generation=?
        WHERE id=? AND team_id=? AND used_at IS NULL AND expires_at>?`).run(hashToken(token), userId, generation, invitationId, teamId, isoNow());
      if (update.changes !== 1) throw conflict('邀请状态已变化，请刷新后重试。');
      return { ...row, generation };
    });
    let delivery: 'sent' | 'failed' = 'failed';
    try {
      await sendInvitationMessage(sendMail, db, config.dataDir, userId, invite.email, invite.team_name, token, config.appOrigin);
      delivery = 'sent';
    } catch { /* Keep the rotated invitation and report delivery status only. */ }
    transaction(db, () => {
      db.prepare(`UPDATE invitations SET delivery_status=?,last_sent_at=? WHERE id=? AND send_generation=? AND used_at IS NULL`)
        .run(delivery, delivery === 'sent' ? isoNow() : null, invitationId, invite.generation);
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), teamId, userId, 'invitation.resend', 'invitation', invitationId, isoNow(), JSON.stringify({ delivery }));
    });
    return { invitation: invitationDto(db, invitationId), delivery };
  });
}



