import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.js';
import type { Db } from './db.js';
import { transaction } from './db.js';
import { requireUserId, createSession, setSessionCookie } from './auth.js';
import { conflict, forbidden, notFound, unauthorized } from './errors.js';
import { expiresInDays, hashPassword, hashToken, isoNow, newToken, verifyPassword } from './security.js';
import { validateBody, validateParams } from './validation.js';
import { hasExplicitPage, paginate, parsePage } from './pagination.js';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type InvitationRole = Exclude<Role, 'owner'>;
const IdParams = z.object({ teamId: z.string().uuid() }).strict();
const MemberParams = z.object({ teamId: z.string().uuid(), userId: z.string().uuid() }).strict();
const InvitationParams = z.object({ teamId: z.string().uuid(), invitationId: z.string().uuid() }).strict();
const InvitationTokenParams = z.object({ token: z.string().min(32).max(256) }).strict();
const TeamNameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const MemberRoleBody = z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).strict();
const InviteBody = z.object({ email: z.string().trim().email().max(254), role: z.enum(['admin', 'editor', 'viewer']) }).strict();
const AcceptInvitationBody = z.object({ name: z.string().trim().min(1).max(80).optional(), password: z.string().min(12).max(128) }).strict();

interface TeamMemberRow {
  user_id: string;
  role: Role;
  email: string;
  name: string;
  password_hash?: string;
  normalized_email?: string;
}

interface InvitationRow {
  id: string;
  team_id: string;
  team_name: string;
  email: string;
  normalized_email: string;
  role: InvitationRole;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
}

function teamRole(db: Db, teamId: string, userId: string): Role | undefined {
  const result = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: Role } | undefined;
  return result?.role;
}

function requireTeamMember(db: Db, teamId: string, userId: string): Role {
  const role = teamRole(db, teamId, userId);
  if (!role) throw notFound();
  return role;
}

function requireManager(db: Db, teamId: string, userId: string): Role {
  const role = requireTeamMember(db, teamId, userId);
  if (role !== 'owner' && role !== 'admin') throw forbidden();
  return role;
}

function writeAudit(db: Db, teamId: string, actorId: string, action: string, targetType: string, targetId: string): void {
  db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), teamId, actorId, action, targetType, targetId, isoNow());
}

function clearMemberAccess(db: Db, teamId: string, userId: string): void {
  db.prepare(`DELETE FROM space_grants WHERE user_id=? AND space_id IN
    (SELECT id FROM spaces WHERE team_id=?)`).run(userId, teamId);
  db.prepare(`DELETE FROM document_grants WHERE user_id=? AND document_id IN
    (SELECT d.id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=?)`).run(userId, teamId);
}

function memberDto(row: TeamMemberRow) {
  return { id: row.user_id, email: row.email, name: row.name, role: row.role };
}

function assertCanManageRole(actorRole: Role, targetRole: Role, nextRole?: InvitationRole): void {
  if (targetRole === 'owner') throw forbidden('不能修改团队所有者。');
  if (actorRole === 'admin') {
    if (targetRole === 'admin') throw forbidden();
    if (nextRole === 'admin') throw forbidden('只有所有者可以任命管理员。');
  }
}

export function registerTeamRoutes(app: FastifyInstance, { db, config }: AppContext): void {
  app.get('/teams', async (request) => {
    const userId = requireUserId(db, request);
    const teams = db.prepare(`SELECT t.id,t.name,m.role FROM teams t
      JOIN members m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.created_at,t.name`)
      .all(userId) as Array<{ id: string; name: string; role: Role }>;
    return { teams };
  });

  app.post('/teams', {
    preValidation: validateBody(TeamNameBody),
  }, async (request, reply) => {
    const userId = requireUserId(db, request);
    const body = request.body as z.infer<typeof TeamNameBody>;
    const team = transaction(db, () => {
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw unauthorized();
      const id = randomUUID();
      const createdAt = isoNow();
      db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(id, body.name, createdAt);
      db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(id, userId, 'owner', createdAt);
      writeAudit(db, id, userId, 'team.create', 'team', id);
      return { id, name: body.name, role: 'owner' as const };
    });
    return reply.code(201).send({ team });
  });

  app.patch('/teams/:teamId', {
    config: { agentAccess: { scope: 'manage', operation: 'team.manage', teamParam: 'teamId' } },
    preValidation: [validateParams(IdParams), validateBody(TeamNameBody)],
  }, async (request) => {
    const userId = requireUserId(db, request);
    const { teamId } = request.params as z.infer<typeof IdParams>;
    const { name } = request.body as z.infer<typeof TeamNameBody>;
    return transaction(db, () => {
      requireManager(db, teamId, userId);
      db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, teamId);
      writeAudit(db, teamId, userId, 'team.update', 'team', teamId);
      return { team: { id: teamId, name, role: teamRole(db, teamId, userId) } };
    });
  });

  app.get('/teams/:teamId/members', {
    config: { agentAccess: { scope: 'manage', operation: 'member.read', teamParam: 'teamId' } },
    preValidation: validateParams(IdParams),
  }, async (request) => {
    const userId = requireUserId(db, request);
    const { teamId } = request.params as z.infer<typeof IdParams>;
    requireTeamMember(db, teamId, userId);
    const page = parsePage(request.query);
    const members = db.prepare(`SELECT u.id user_id,u.email,u.name,m.role
      FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,u.name`)
      .all(teamId) as unknown as TeamMemberRow[];
    const entries = members.map(memberDto);
    if (!request.agentPrincipal && !hasExplicitPage(request.query)) return { members: entries };
    const pageResult = paginate(entries, page);
    return { members: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.patch('/teams/:teamId/members/:userId', {
    config: { agentAccess: { scope: 'manage', operation: 'member.manage', teamParam: 'teamId' } },
    preValidation: [validateParams(MemberParams), validateBody(MemberRoleBody)],
  }, async (request) => {
    const actorId = requireUserId(db, request);
    const { teamId, userId: targetId } = request.params as z.infer<typeof MemberParams>;
    const { role: nextRole } = request.body as z.infer<typeof MemberRoleBody>;
    return transaction(db, () => {
      const actorRole = requireManager(db, teamId, actorId);
      const target = db.prepare(`SELECT m.role,u.email,u.normalized_email FROM members m
        JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=?`).get(teamId, targetId) as
        { role: Role; email: string; normalized_email: string } | undefined;
      if (!target) throw notFound();
      assertCanManageRole(actorRole, target.role, nextRole);
      if (targetId === actorId) throw forbidden('不能修改自己的团队角色。');
      db.prepare('UPDATE members SET role=? WHERE team_id=? AND user_id=?').run(nextRole, teamId, targetId);
      clearMemberAccess(db, teamId, targetId);
      db.prepare('DELETE FROM invitations WHERE team_id=? AND normalized_email=? AND used_at IS NULL')
        .run(teamId, target.normalized_email);
      writeAudit(db, teamId, actorId, 'member.role.update', 'user', targetId);
      return { member: { id: targetId, email: target.email, name: (db.prepare('SELECT name FROM users WHERE id=?').get(targetId) as { name: string }).name, role: nextRole } };
    });
  });

  app.delete('/teams/:teamId/members/:userId', {
    config: { agentAccess: { scope: 'manage', operation: 'member.manage', teamParam: 'teamId' } },
    preValidation: validateParams(MemberParams),
  }, async (request) => {
    const actorId = requireUserId(db, request);
    const { teamId, userId: targetId } = request.params as z.infer<typeof MemberParams>;
    return transaction(db, () => {
      const actorRole = requireManager(db, teamId, actorId);
      const target = db.prepare(`SELECT m.role,u.normalized_email FROM members m JOIN users u ON u.id=m.user_id
        WHERE m.team_id=? AND m.user_id=?`).get(teamId, targetId) as { role: Role; normalized_email: string } | undefined;
      if (!target) throw notFound();
      assertCanManageRole(actorRole, target.role);
      if (targetId === actorId) throw forbidden('不能移除自己。');
      clearMemberAccess(db, teamId, targetId);
      db.prepare('DELETE FROM invitations WHERE team_id=? AND normalized_email=? AND used_at IS NULL')
        .run(teamId, target.normalized_email);
      db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE team_id=? AND user_id=? AND revoked_at IS NULL').run(isoNow(), teamId, targetId);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
      db.prepare('DELETE FROM members WHERE team_id=? AND user_id=?').run(teamId, targetId);
      writeAudit(db, teamId, actorId, 'member.remove', 'user', targetId);
      return { ok: true };
    });
  });

  app.get('/teams/:teamId/invitations', {
    config: { agentAccess: { scope: 'manage', operation: 'invite.read', teamParam: 'teamId' } },
    preValidation: validateParams(IdParams),
  }, async (request) => {
    const userId = requireUserId(db, request);
    const { teamId } = request.params as z.infer<typeof IdParams>;
    requireManager(db, teamId, userId);
    const page = parsePage(request.query);
    const invitations = db.prepare(`SELECT id,email,role,created_at,expires_at FROM invitations
      WHERE team_id=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC`).all(teamId, isoNow()) as
      Array<{ id: string; email: string; role: InvitationRole; created_at: string; expires_at: string }>;
    const entries = invitations.map((entry) => ({ id: entry.id, email: entry.email, role: entry.role, createdAt: entry.created_at, expiresAt: entry.expires_at }));
    if (!request.agentPrincipal && !hasExplicitPage(request.query)) return { invitations: entries };
    const pageResult = paginate(entries, page);
    return { invitations: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.post('/teams/:teamId/invitations', {
    config: { agentAccess: { scope: 'manage', operation: 'invite.manage', teamParam: 'teamId' } },
    preValidation: [validateParams(IdParams), validateBody(InviteBody)],
  }, async (request, reply) => {
    const actorId = requireUserId(db, request);
    const { teamId } = request.params as z.infer<typeof IdParams>;
    const body = request.body as z.infer<typeof InviteBody>;
    const email = body.email.trim().toLowerCase();
    const token = newToken();
    const id = randomUUID();
    const invitation = transaction(db, () => {
      const actorRole = requireManager(db, teamId, actorId);
      if (body.role === 'admin' && actorRole !== 'owner') throw forbidden('只有所有者可以邀请管理员。');
      if (db.prepare('SELECT 1 FROM users WHERE normalized_email=?').get(email) &&
          db.prepare('SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.normalized_email=?').get(teamId, email)) {
        throw conflict('该用户已经是团队成员。');
      }
      if (db.prepare('SELECT 1 FROM invitations WHERE team_id=? AND normalized_email=? AND used_at IS NULL AND expires_at>?').get(teamId, email, isoNow())) {
        throw conflict('该邮箱已有待处理邀请。');
      }
      const now = isoNow();
      const expiresAt = expiresInDays(7);
      const team = db.prepare('SELECT name FROM teams WHERE id=?').get(teamId) as { name: string } | undefined;
      if (!team) throw notFound();
      db.prepare(`INSERT INTO invitations(id,team_id,email,normalized_email,role,token_hash,created_by,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, teamId, email, email, body.role, hashToken(token), actorId, now, expiresAt);
      writeAudit(db, teamId, actorId, 'invitation.create', 'invitation', id);
      return { id, email, role: body.role, createdAt: now, expiresAt, teamName: team.name };
    });
    return reply.code(201).send({ invitation: { id: invitation.id, email: invitation.email, role: invitation.role, createdAt: invitation.createdAt, expiresAt: invitation.expiresAt }, token });
  });

  app.delete('/teams/:teamId/invitations/:invitationId', {
    config: { agentAccess: { scope: 'manage', operation: 'invite.manage', teamParam: 'teamId' } },
    preValidation: validateParams(InvitationParams),
  }, async (request) => {
    const actorId = requireUserId(db, request);
    const { teamId, invitationId } = request.params as z.infer<typeof InvitationParams>;
    return transaction(db, () => {
      requireManager(db, teamId, actorId);
      const result = db.prepare('DELETE FROM invitations WHERE id=? AND team_id=?').run(invitationId, teamId);
      if (result.changes === 0) throw notFound();
      writeAudit(db, teamId, actorId, 'invitation.cancel', 'invitation', invitationId);
      return { ok: true };
    });
  });

  app.get('/invitations/:token', {
    preValidation: validateParams(InvitationTokenParams),
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request) => {
    const { token } = request.params as z.infer<typeof InvitationTokenParams>;
    const invite = db.prepare(`SELECT i.email,i.role,i.expires_at,t.name AS team_name FROM invitations i
      JOIN teams t ON t.id=i.team_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>?`)
      .get(hashToken(token), isoNow()) as { email: string; role: InvitationRole; expires_at: string; team_name: string } | undefined;
    if (!invite) throw notFound();
    return { teamName: invite.team_name, email: invite.email, role: invite.role, expiresAt: invite.expires_at };
  });

  app.post('/invitations/:token/accept', {
    preValidation: [validateParams(InvitationTokenParams), validateBody(AcceptInvitationBody)],
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const { token } = request.params as z.infer<typeof InvitationTokenParams>;
    const body = request.body as z.infer<typeof AcceptInvitationBody>;
    const tokenHash = hashToken(token);
    const now = isoNow();
    const currentInvite = db.prepare(`SELECT i.id,i.team_id,i.email,i.normalized_email,i.role,i.expires_at,i.used_at,t.name AS team_name
      FROM invitations i JOIN teams t ON t.id=i.team_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>?`)
      .get(tokenHash, now) as InvitationRow | undefined;
    if (!currentInvite) throw notFound();

    const existingUser = db.prepare('SELECT id,email,name,password_hash,normalized_email FROM users WHERE normalized_email=?')
      .get(currentInvite.normalized_email) as { id: string; email: string; name: string; password_hash: string; normalized_email: string } | undefined;
    let newPasswordHash: string | undefined;
    if (existingUser) {
      if (!(await verifyPassword(body.password, existingUser.password_hash))) throw forbidden('现有账号密码不正确。');
    } else {
      if (!body.name) throw forbidden('新账号需要提供姓名。');
      newPasswordHash = await hashPassword(body.password);
    }

    const result = transaction(db, () => {
      const invite = db.prepare(`SELECT id,team_id,email,normalized_email,role,token_hash,expires_at,used_at
        FROM invitations WHERE token_hash=?`).get(tokenHash) as InvitationRow | undefined;
      if (!invite || invite.used_at || invite.expires_at <= isoNow()) throw conflict('邀请已使用或已过期。');
      const account = db.prepare('SELECT id,email,name,password_hash FROM users WHERE normalized_email=?')
        .get(invite.normalized_email) as { id: string; email: string; name: string; password_hash: string } | undefined;
      let userId: string;
      let user: { id: string; email: string; name: string };
      if (existingUser) {
        if (!account || account.id !== existingUser.id || account.password_hash !== existingUser.password_hash) {
          throw conflict('账号状态已变化，请使用当前密码重新接受邀请。');
        }
        userId = account.id;
        user = { id: account.id, email: account.email, name: account.name };
      } else {
        if (account) throw conflict('该邮箱已有账号，请使用现有密码重新接受邀请。');
        userId = randomUUID();
        const name = body.name!.trim();
        db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
          .run(userId, invite.email, invite.normalized_email, name, newPasswordHash!, isoNow());
        user = { id: userId, email: invite.email, name };
      }
      if (db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(invite.team_id, userId)) {
        throw conflict('该用户已经是团队成员。');
      }
      db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(invite.team_id, userId, invite.role, isoNow());
      const usedAt = isoNow();
      const consumed = db.prepare('UPDATE invitations SET used_at=? WHERE id=? AND used_at IS NULL')
        .run(usedAt, invite.id);
      if (consumed.changes !== 1) throw conflict('邀请已使用。');
      writeAudit(db, invite.team_id, userId, 'invitation.accept', 'invitation', invite.id);
      const sessionToken = createSession(db, userId);
      return { user, teams: db.prepare(`SELECT t.id,t.name,m.role FROM teams t JOIN members m ON m.team_id=t.id
        WHERE m.user_id=? ORDER BY t.created_at,t.name`).all(userId), sessionToken };
    });
    setSessionCookie(reply, config, result.sessionToken);
    return reply.code(200).send({ user: result.user, teams: result.teams });
  });
}
