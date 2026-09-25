import type { FastifyInstance, InjectOptions } from 'fastify';
import { McpServer, createMcpHandler, type ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { AgentPrincipal } from './agentAuth.js';

type ToolInput = Record<string, unknown>;
type RestReply = { statusCode: number; body: unknown; headers: Record<string, unknown> };

const Id = z.string().uuid();
const nonEmpty = z.string().trim().min(1);
const emptyArgs = {};
const pageArgs = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() };
const spaceArgs = { spaceId: Id, ...pageArgs };
const docArgs = { documentId: Id };
const searchArgs = { query: nonEmpty.max(100), spaceId: Id.optional(), ...pageArgs };

function resultText(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

export function createTeamShelfMcpHandler(options: {
  app: FastifyInstance;
  config: AppConfig;
  principal: AgentPrincipal;
  token: string;
}) {
  const { app, principal, token } = options;
  const makeServer = () => {
  const server = new McpServer({ name: 'teamshelf', version: '0.2.0' });

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: unknown): Promise<RestReply> => {
    const requestOptions: InjectOptions = {
      method,
      url: `/api${path}`,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      headers: { authorization: `Bearer ${token}`, 'x-requested-with': 'TeamShelf', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    };
    const response = await app.inject(requestOptions);
    let body: unknown;
    if (response.headers['content-type']?.toString().includes('text/markdown')) body = response.body;
    else { try { body = response.json(); } catch { body = { error: { code: 'INTERNAL_ERROR', message: '请求失败。' } }; } }
    return { statusCode: response.statusCode, body, headers: response.headers as Record<string, unknown> };
  };
  const run = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: unknown) => {
    try {
      const response = await call(method, path, payload);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { ...resultText(response.body), isError: true };
      }
      return resultText(response.body);
    } catch {
      return { ...resultText({ error: { code: 'INTERNAL_ERROR', message: '请求暂时失败。' } }), isError: true };
    }
  };
  const register = (name: string, description: string, shape: Record<string, z.ZodType>, callback: (args: ToolInput) => Promise<unknown>) => {
    const readOnly = new Set(['whoami','list_spaces','list_documents','search_documents','get_document','get_revisions','get_revision','export_document','list_members','list_invitations','list_audit']);
    const destructive = new Set(['update_document','set_space_access','set_document_access','delete_document','restore_document','update_space','delete_space','rename_team','change_member_role','remove_member','cancel_invitation']);
    const annotations: ToolAnnotations = { readOnlyHint: readOnly.has(name), destructiveHint: destructive.has(name), openWorldHint: false };
    server.registerTool(name, { description, inputSchema: shape, annotations }, async (args) => callback(args as ToolInput) as never);
  };

  register('whoami', '查看当前凭据绑定的团队和有效权限。', emptyArgs, () => run('GET', '/agent/identity'));
  register('list_spaces', '列出当前团队中可访问的知识库，可用offset/limit继续分页。', pageArgs, ({ offset, limit }) => run('GET', `/teams/${principal.teamId}/spaces?offset=${offset ?? 0}&limit=${limit ?? 100}`));
  register('list_documents', '列出知识库中可访问的文档，可用offset/limit继续分页。', spaceArgs, ({ spaceId, offset, limit }) => run('GET', `/spaces/${spaceId}/documents?offset=${offset ?? 0}&limit=${limit ?? 100}`));
  register('search_documents', '在当前团队或指定知识库范围内搜索，可用offset/limit继续分页。', searchArgs, async ({ query, spaceId, offset, limit }) => {
    const params = new URLSearchParams({ q: String(query), offset: String(offset ?? 0), limit: String(limit ?? 100) });
    if (spaceId) params.set('spaceId', String(spaceId));
    const reply = await call('GET', `/teams/${principal.teamId}/search?${params.toString()}`);
    if (reply.statusCode < 200 || reply.statusCode >= 300) return { ...resultText(reply.body), isError: true };
    return resultText(reply.body);
  });
  register('get_document', '读取一篇可访问文档的正文。', docArgs, ({ documentId }) => run('GET', `/documents/${documentId}`));
  register('get_revisions', '列出文档历史版本元数据（不包含正文），可用offset/limit继续分页。', { ...docArgs, ...pageArgs }, async ({ documentId, offset, limit }) => {
    const reply = await call('GET', `/documents/${documentId}/revisions?offset=${offset ?? 0}&limit=${limit ?? 100}`);
    if (reply.statusCode < 200 || reply.statusCode >= 300) return { ...resultText(reply.body), isError: true };
    const revisions = (reply.body as { revisions?: Array<Record<string, unknown>> }).revisions ?? [];
    return resultText({ ...reply.body as Record<string, unknown>, revisions: revisions.map(({ body: _body, ...revision }) => revision) });
});
  register('get_revision', '读取指定历史版本的完整 Markdown 正文。', { ...docArgs, revisionId: Id }, ({ documentId, revisionId }) => run('GET', `/documents/${documentId}/revisions/${revisionId}`));
  register('export_document', '导出文档的 Markdown 正文。', docArgs, ({ documentId }) => run('GET', `/documents/${documentId}/export`));

  const effective = principal.teamRole === 'viewer' ? 'read' : principal.teamRole === 'editor' ? 'write' : 'manage';
  const scope = ['read', 'write', 'manage'].indexOf(principal.scope) <= ['read', 'write', 'manage'].indexOf(effective) ? principal.scope : effective;
  if (scope === 'write' || scope === 'manage') {
    register('create_document', '在知识库中创建 Markdown 文档。权限默认为继承知识库。', {
      spaceId: Id, title: nonEmpty.max(200), markdown: z.string().max(500 * 1024).optional(),
    }, ({ spaceId, title, markdown }) => run('POST', `/spaces/${spaceId}/documents`, { title, body: markdown ?? '', visibility: 'inherit', grants: [] }));
    register('update_document', '更新文档标题和 Markdown 正文，必须提供当前版本号。', {
      documentId: Id, title: nonEmpty.max(200), markdown: z.string().max(500 * 1024), version: z.number().int().positive(),
    }, ({ documentId, title, markdown, version }) => run('PATCH', `/documents/${documentId}`, { title, body: markdown, version }));
  }

  if (scope === 'manage') {
    const accessSchema = { visibility: z.enum(['team', 'restricted']), grants: z.array(z.object({ userId: Id, role: z.enum(['viewer', 'editor']) }).strict()).max(500) };
    const docAccessSchema = { visibility: z.enum(['inherit', 'restricted']), grants: z.array(z.object({ userId: Id, role: z.enum(['viewer', 'editor']) }).strict()).max(500) };
    register('set_space_access', '设置知识库可见性和成员授权。', { spaceId: Id, ...accessSchema }, ({ spaceId, visibility, grants }) => run('PUT', `/spaces/${spaceId}/access`, { visibility, grants }));
    register('set_document_access', '设置文档可见性和成员授权。', { documentId: Id, ...docAccessSchema }, ({ documentId, visibility, grants }) => run('PUT', `/documents/${documentId}/access`, { visibility, grants }));
    register('delete_document', '删除文档。', docArgs, ({ documentId }) => run('DELETE', `/documents/${documentId}`));
    register('restore_document', '恢复历史版本为新版本。', { documentId: Id, revisionId: Id, version: z.number().int().positive() }, ({ documentId, revisionId, version }) => run('POST', `/documents/${documentId}/revisions/${revisionId}/restore`, { version }));
    if (!principal.spaceId) {
      register('create_space', '在当前团队创建知识库。', { name: nonEmpty.max(200), description: z.string().max(2000).optional() }, ({ name, description }) => run('POST', `/teams/${principal.teamId}/spaces`, { name, description: description ?? '', visibility: 'team', grants: [] }));
      register('update_space', '修改知识库名称或说明。', { spaceId: Id, name: nonEmpty.max(200).optional(), description: z.string().max(2000).optional() }, ({ spaceId, name, description }) => run('PATCH', `/spaces/${spaceId}`, { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) }));
      register('delete_space', '删除空知识库。', spaceArgs, ({ spaceId }) => run('DELETE', `/spaces/${spaceId}`));
      register('rename_team', '修改当前团队名称。', { name: nonEmpty.max(100) }, ({ name }) => run('PATCH', `/teams/${principal.teamId}`, { name }));
      register('list_members', '列出当前团队成员。', emptyArgs, () => run('GET', `/teams/${principal.teamId}/members`));
      register('change_member_role', '修改团队成员角色。', { userId: Id, role: z.enum(['admin', 'editor', 'viewer']) }, ({ userId, role }) => run('PATCH', `/teams/${principal.teamId}/members/${userId}`, { role }));
      register('remove_member', '移除团队成员。', { userId: Id }, ({ userId }) => run('DELETE', `/teams/${principal.teamId}/members/${userId}`));
      register('list_invitations', '列出当前团队待处理邀请。', emptyArgs, () => run('GET', `/teams/${principal.teamId}/invitations`));
      register('invite_member', '邀请成员加入当前团队。', { email: z.string().trim().email().max(254), role: z.enum(['admin', 'editor', 'viewer']) }, ({ email, role }) => run('POST', `/teams/${principal.teamId}/invitations`, { email, role }));
      register('cancel_invitation', '取消当前团队邀请。', { invitationId: Id }, ({ invitationId }) => run('DELETE', `/teams/${principal.teamId}/invitations/${invitationId}`));
      register('list_audit', '查看当前团队最近审计事件。', emptyArgs, () => run('GET', `/teams/${principal.teamId}/audit`));
    }
  }
  return server;
  };
  return createMcpHandler(makeServer, { responseMode: 'json' });
}
