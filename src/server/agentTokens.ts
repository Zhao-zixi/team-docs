import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentCredentialSummary, AgentScope, TeamRole } from '../shared/types.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { forbidden, notFound } from './errors.js';
import { getSpaceAccess } from './acl.js';
import { requireUserId } from './auth.js';
import { expiresInDays, hashToken, isoNow, newToken } from './security.js';
import { validateBody, validateParams } from './validation.js';

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  teamId: z.string().uuid(),
  scope: z.enum(['read', 'write', 'manage']).default('read'),
  spaceId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(90).default(30),
}).strict();
const IdParams = z.object({ id: z.string().uuid() }).strict();
const TeamParams = z.object({ teamId: z.string().uuid() }).strict();

interface CredentialRow {
  id: string; user_id: string; user_name: string; name: string; team_id: string; space_id: string | null;
  space_name: string | null; scope: AgentScope; token_hint: string; created_at: string; expires_at: string;
  last_used_at: string | null; revoked_at: string | null; owner_role: TeamRole | null;
}

function roleFor(db: AppContext['db'], teamId: string, userId: string): TeamRole | undefined {
  return (db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: TeamRole } | undefined)?.role;
}

function canIssue(scope: AgentScope, role: TeamRole): boolean {
  return scope === 'read' || (scope === 'write' && role !== 'viewer') || (scope === 'manage' && (role === 'owner' || role === 'admin'));
}

function canRevoke(actorId: string, actorRole: TeamRole | null, row: CredentialRow): boolean {
  if (actorId === row.user_id) return true;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && (row.owner_role === 'editor' || row.owner_role === 'viewer');
}

function toSummary(actorId: string, actorRole: TeamRole | null, row: CredentialRow): AgentCredentialSummary {
  return {
    id: row.id, userId: row.user_id, userName: row.user_name, name: row.name, teamId: row.team_id,
    spaceId: row.space_id, ...(row.space_name ? { spaceName: row.space_name } : {}), scope: row.scope,
    tokenHint: row.token_hint, createdAt: row.created_at, expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, canRevoke: canRevoke(actorId, actorRole, row),
  };
}

const rowsForUser = `SELECT a.id,a.user_id,u.name AS user_name,a.name,a.team_id,a.space_id,s.name AS space_name,
  a.scope,a.token_hint,a.created_at,a.expires_at,a.last_used_at,a.revoked_at,m.role AS owner_role
  FROM agent_tokens a JOIN users u ON u.id=a.user_id
  LEFT JOIN spaces s ON s.id=a.space_id
  LEFT JOIN members m ON m.team_id=a.team_id AND m.user_id=a.user_id`;

export function registerAgentCredentialRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get('/agent/identity', { config: { agentAccess: { scope: 'read', operation: 'identity' } } }, async (request) => {
    const principal = request.agentPrincipal;
    if (!principal) throw forbidden('此端点仅供Agent身份验证。');
    const user = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(principal.userId) as { id: string; email: string; name: string } | undefined;
    const team = db.prepare('SELECT id,name FROM teams WHERE id=?').get(principal.teamId) as { id: string; name: string } | undefined;
    if (!user || !team) throw notFound();
    const roleScope = principal.teamRole === 'viewer' ? 'read' : principal.teamRole === 'editor' ? 'write' : 'manage';
    return { user, team: { ...team, role: principal.teamRole }, credential: { id: principal.credentialId, scope: principal.scope, spaceId: principal.spaceId }, effectiveScope: ({ read: 0, write: 1, manage: 2 } as const)[principal.scope] <= ({ read: 0, write: 1, manage: 2 } as const)[roleScope] ? principal.scope : roleScope };
  });
  app.get('/agent-tokens', async (request) => {
    const userId = requireUserId(db, request);
    const rows = db.prepare(`${rowsForUser} WHERE a.user_id=? ORDER BY a.created_at DESC,a.id`).all(userId) as unknown as CredentialRow[];
    return { credentials: rows.map((row) => toSummary(userId, roleFor(db, row.team_id, userId) ?? null, row)) };
  });

  app.get('/teams/:teamId/agent-tokens', { preValidation: validateParams(TeamParams) }, async (request) => {
    const userId = requireUserId(db, request);
    const { teamId } = request.params as z.infer<typeof TeamParams>;
    const actorRole = roleFor(db, teamId, userId);
    if (!actorRole) throw notFound();
    if (actorRole !== 'owner' && actorRole !== 'admin') throw forbidden();
    const rows = db.prepare(`${rowsForUser} WHERE a.team_id=? ORDER BY a.created_at DESC,a.id`).all(teamId) as unknown as CredentialRow[];
    return { credentials: rows.map((row) => toSummary(userId, actorRole, row)) };
  });

  app.post('/agent-tokens', { config: { rateLimit: { max: 10, timeWindow: 60_000 } }, preValidation: validateBody(CreateBody) }, async (request, reply) => {
    const userId = requireUserId(db, request);
    const input = request.body as z.infer<typeof CreateBody>;
    const role = roleFor(db, input.teamId, userId);
    if (!role) throw notFound();
    if (!canIssue(input.scope, role)) throw forbidden('当前团队角色不能签发此权限级别的凭据。');
    if (input.spaceId) {
      const access = getSpaceAccess(db, userId, input.spaceId);
      if (!access || access.teamId !== input.teamId || !access.canRead) throw notFound();
    }
    const id = randomUUID();
    const token = `ts_agent_${newToken()}`;
    const tokenHint = `ts_agent_${token.slice(9, 13)}…${token.slice(-4)}`;
    const now = isoNow();
    const expiresAt = expiresInDays(input.expiresInDays);
    transaction(db, () => {
      db.prepare(`INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.teamId, input.spaceId ?? null, input.name.trim(), input.scope,
        hashToken(token), tokenHint, now, expiresAt);
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), input.teamId, userId, 'agent-token.create', 'agent-token', id, now,
        JSON.stringify({ name: input.name.trim(), scope: input.scope, spaceId: input.spaceId ?? null }));
    });
    const row = db.prepare(`${rowsForUser} WHERE a.id=?`).get(id) as unknown as CredentialRow;
    return reply.code(201).send({ credential: toSummary(userId, role, row), token });
  });

  app.delete('/agent-tokens/:id', { preValidation: validateParams(IdParams) }, async (request) => {
    const actorId = requireUserId(db, request);
    const { id } = request.params as z.infer<typeof IdParams>;
    return transaction(db, () => {
      const row = db.prepare(`${rowsForUser} WHERE a.id=?`).get(id) as unknown as CredentialRow | undefined;
      if (!row) throw notFound();
      const actorRole = roleFor(db, row.team_id, actorId) ?? null;
      if (!canRevoke(actorId, actorRole, row)) throw forbidden();
      if (row.revoked_at) return { ok: true };
      const now = isoNow();
      db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, id);
      db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), row.team_id, actorId, 'agent-token.revoke', 'agent-token', id, now,
        JSON.stringify({ ownerUserId: row.user_id }));
      return { ok: true };
    });
  });
}
