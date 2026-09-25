import type { FastifyRequest } from 'fastify';
import type { AgentScope, TeamRole } from '../shared/types.js';
import type { Db } from './db.js';
import { forbidden, notFound, unauthorized } from './errors.js';
import { hashToken, isoNow } from './security.js';

export interface AgentPrincipal {
  userId: string;
  credentialId: string;
  teamId: string;
  spaceId: string | null;
  scope: AgentScope;
  teamRole: TeamRole;
}

export type AgentOperation =
  | 'identity' | 'team.read' | 'team.manage' | 'member.read' | 'member.manage'
  | 'invite.read' | 'invite.manage' | 'space.read' | 'space.manage'
  | 'document.read' | 'document.write' | 'document.manage' | 'audit.read';

export interface AgentRoutePolicy {
  scope: AgentScope;
  operation: AgentOperation;
  teamParam?: 'teamId';
  spaceParam?: 'spaceId';
  documentParam?: 'id';
  allowSpaceBound?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    agentPrincipal?: AgentPrincipal;
  }
  interface FastifyContextConfig {
    agentAccess?: AgentRoutePolicy;
  }
}

const scopeRank: Record<AgentScope, number> = { read: 0, write: 1, manage: 2 };
const roleScope: Record<TeamRole, AgentScope> = { viewer: 'read', editor: 'write', admin: 'manage', owner: 'manage' };

export function scopeAllows(actual: AgentScope, required: AgentScope): boolean {
  return scopeRank[actual] >= scopeRank[required];
}

export function authenticateAgentToken(db: Db, token: string): AgentPrincipal {
  if (!/^ts_agent_[A-Za-z0-9_-]{32,}$/.test(token)) throw unauthorized();
  const row = db.prepare(`SELECT a.id,a.user_id,a.team_id,a.space_id,a.scope,m.role
    FROM agent_tokens a JOIN members m ON m.team_id=a.team_id AND m.user_id=a.user_id
    WHERE a.token_hash=? AND a.revoked_at IS NULL AND a.expires_at>?`)
    .get(hashToken(token), isoNow()) as {
      id: string; user_id: string; team_id: string; space_id: string | null; scope: AgentScope; role: TeamRole;
    } | undefined;
  if (!row) throw unauthorized();
  if (row.space_id && !db.prepare('SELECT 1 FROM spaces WHERE id=? AND team_id=?').get(row.space_id, row.team_id)) throw unauthorized();
  db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL').run(isoNow(), row.id);
  return {
    userId: row.user_id,
    credentialId: row.id,
    teamId: row.team_id,
    spaceId: row.space_id,
    scope: row.scope,
    teamRole: row.role,
  };
}

export function authorizeAgentRoute(
  db: Db,
  principal: AgentPrincipal,
  policy: AgentRoutePolicy | undefined,
  params: unknown,
): void {
  if (!policy) throw forbidden('Bearer 不允许访问此端点。');
  const effective = scopeRank[principal.scope] <= scopeRank[roleScope[principal.teamRole]]
    ? principal.scope : roleScope[principal.teamRole];
  if (!scopeAllows(effective, policy.scope)) throw forbidden('Agent 凭据权限不足。');
  const routeParams = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  if (policy.teamParam) {
    if (routeParams[policy.teamParam] !== principal.teamId) throw notFound();
  }
  if (principal.spaceId && !policy.allowSpaceBound) throw forbidden('空间限定凭据不能访问团队级操作。');
  if (policy.spaceParam) {
    const spaceId = routeParams[policy.spaceParam];
    if (typeof spaceId !== 'string') throw notFound();
    const space = db.prepare('SELECT team_id FROM spaces WHERE id=?').get(spaceId) as { team_id: string } | undefined;
    if (!space || space.team_id !== principal.teamId) throw notFound();
    if (principal.spaceId && principal.spaceId !== spaceId) throw notFound();
  }
  if (policy.documentParam) {
    const documentId = routeParams[policy.documentParam];
    if (typeof documentId !== 'string') throw notFound();
    const document = db.prepare(`SELECT s.team_id,d.space_id FROM documents d
      JOIN spaces s ON s.id=d.space_id WHERE d.id=?`).get(documentId) as { team_id: string; space_id: string } | undefined;
    if (!document || document.team_id !== principal.teamId) throw notFound();
    if (principal.spaceId && document.space_id !== principal.spaceId) throw notFound();
  }
}

export function principalFromRequest(request: FastifyRequest): AgentPrincipal | undefined {
  return request.agentPrincipal;
}