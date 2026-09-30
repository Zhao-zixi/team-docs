import type { FastifyRequest } from 'fastify';
import type { TeamRole } from '../shared/types.js';
import type { Db } from './db.js';
import { forbidden, HttpError, notFound, unauthorized } from './errors.js';
import { verifyPassword } from './security.js';

export interface AgentPrincipal { userId: string; }
export type AgentOperation =
  | 'identity' | 'team.read' | 'team.manage' | 'member.read' | 'member.manage'
  | 'invite.read' | 'invite.manage' | 'space.read' | 'space.manage' | 'proposal.read' | 'proposal.write'
  | 'document.read' | 'document.write' | 'document.manage' | 'comment.read' | 'comment.write' | 'audit.read';
export interface AgentRoutePolicy {
  scope: 'read' | 'write' | 'manage'; operation: AgentOperation;
  teamParam?: 'teamId'; spaceParam?: 'spaceId'; documentParam?: 'id';
  proposalParam?: 'id'; commentParam?: 'threadId'; allowSpaceBound?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest { agentPrincipal?: AgentPrincipal; }
  interface FastifyContextConfig { agentAccess?: AgentRoutePolicy; }
}

type Credentials = { email: string; password: string };
type Attempt = { count: number; expiresAt: number; touchedAt: number };
const failures = new Map<string, Attempt>();
const failureWindowMs = 60_000;
const maxFailures = 20;
const maxFailureKeys = 4096;

export function parseBasicAuthorization(value: string | undefined): Credentials {
  if (!value || value.length > 1024 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value)) throw unauthorized();
  const encoded = value.slice(6);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw unauthorized();
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw unauthorized(); }
  const separator = decoded.indexOf(':');
  if (separator < 1) throw unauthorized();
  const email = decoded.slice(0, separator).trim().toLowerCase();
  const password = decoded.slice(separator + 1);
  if (!email || email.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 512) throw unauthorized();
  return { email, password };
}

function failureKey(ip: string): string { return ip.slice(0, 80) || 'unknown-ip'; }
function pruneFailures(now: number): void {
  for (const [key, attempt] of failures) if (attempt.expiresAt <= now) failures.delete(key);
  while (failures.size >= maxFailureKeys) {
    let oldestKey: string | undefined; let oldest = Infinity;
    for (const [key, attempt] of failures) if (attempt.touchedAt < oldest) { oldest = attempt.touchedAt; oldestKey = key; }
    if (!oldestKey) break;
    failures.delete(oldestKey);
  }
}
function recordFailure(ip: string): void {
  const now = Date.now(); pruneFailures(now);
  const key = failureKey(ip); const current = failures.get(key);
  if (!current || current.expiresAt <= now) failures.set(key, { count: 1, expiresAt: now + failureWindowMs, touchedAt: now });
  else { current.count++; current.touchedAt = now; }
}

export async function authenticateBasicAccount(db: Db, authorization: string | undefined, ip: string): Promise<AgentPrincipal> {
  const now = Date.now(); pruneFailures(now);
  const key = failureKey(ip);
  const attempt = failures.get(key);
  if (attempt !== undefined && attempt.count >= maxFailures) throw new HttpError(429, 'RATE_LIMITED', '登录尝试过于频繁，请等待后重试。');
  let credentials: Credentials;
  try { credentials = parseBasicAuthorization(authorization); } catch { recordFailure(ip); throw unauthorized(); }
  const user = db.prepare('SELECT id,password_hash FROM users WHERE normalized_email=?').get(credentials.email) as { id: string; password_hash: string } | undefined;
  const dummyHash = 'scrypt$32768$8$3$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);
  const valid = await verifyPassword(credentials.password, user?.password_hash ?? dummyHash);
  if (valid && user) return { userId: user.id };
  recordFailure(ip);
  throw unauthorized();
}
export function resetBasicFailureStateForTests(): void { failures.clear(); }

export function authorizeAgentRoute(db: Db, principal: AgentPrincipal, policy: AgentRoutePolicy | undefined, params: unknown): void {
  if (!policy) throw forbidden('Basic 认证不允许访问此端点。');
  if (policy.operation === 'identity') {
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(principal.userId)) throw unauthorized();
    return;
  }
  const routeParams = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  let teamId: string | undefined;
  if (policy.teamParam) {
    const id = routeParams[policy.teamParam]; if (typeof id !== 'string') throw notFound(); teamId = id;
  } else if (policy.spaceParam) {
    const id = routeParams[policy.spaceParam]; if (typeof id !== 'string') throw notFound();
    teamId = (db.prepare('SELECT team_id FROM spaces WHERE id=?').get(id) as { team_id: string } | undefined)?.team_id;
  } else if (policy.documentParam) {
    const id = routeParams[policy.documentParam]; if (typeof id !== 'string') throw notFound();
    teamId = (db.prepare('SELECT s.team_id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=?').get(id) as { team_id: string } | undefined)?.team_id;
  } else if (policy.proposalParam) {
    const id = routeParams[policy.proposalParam]; if (typeof id !== 'string') throw notFound();
    teamId = (db.prepare('SELECT team_id FROM proposals WHERE id=?').get(id) as { team_id: string } | undefined)?.team_id;
  } else if (policy.commentParam) {
    const id = routeParams[policy.commentParam]; if (typeof id !== 'string') throw notFound();
    teamId = (db.prepare('SELECT s.team_id FROM document_comments c JOIN documents d ON d.id=c.document_id JOIN spaces s ON s.id=d.space_id WHERE c.id=?').get(id) as { team_id: string } | undefined)?.team_id;
  }
  const role = teamId ? (db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, principal.userId) as { role: TeamRole } | undefined)?.role : undefined;
  if (!role) throw notFound();
  const rank = (value: TeamRole | AgentRoutePolicy['scope']) => value === 'viewer' || value === 'read' ? 0 : value === 'editor' || value === 'write' ? 1 : 2;
  if (rank(role) < rank(policy.scope)) throw forbidden('当前团队角色权限不足。');
}
export function principalFromRequest(request: FastifyRequest): AgentPrincipal | undefined { return request.agentPrincipal; }
