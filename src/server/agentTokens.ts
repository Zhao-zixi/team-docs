import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { listUserTeams } from './auth.js';
import { HttpError, forbidden, unauthorized } from './errors.js';

function removed(): never {
  throw new HttpError(410, 'MCP_CREDENTIALS_REMOVED', '个人访问令牌已停用。请在 MCP 客户端配置账号邮箱和密码。');
}

export function registerAgentCredentialRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get('/agent/identity', { config: { agentAccess: { scope: 'read', operation: 'identity' } } }, async (request) => {
    const principal = request.agentPrincipal;
    if (!principal) throw forbidden('此端点仅供MCP账号身份验证。');
    const user = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(principal.userId) as { id: string; email: string; name: string } | undefined;
    if (!user) throw unauthorized();
    return { user, teams: listUserTeams(db, principal.userId) };
  });
  app.get('/agent-tokens', async () => removed());
  app.get('/teams/:teamId/agent-tokens', async () => removed());
  app.post('/agent-tokens', async () => removed());
  app.delete('/agent-tokens/:id', async () => removed());
}
