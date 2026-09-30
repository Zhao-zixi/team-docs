import type { FastifyInstance, InjectOptions } from 'fastify';
import { McpServer, createMcpHandler, type ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { AgentPrincipal } from './agentAuth.js';
import type { Db } from './db.js';

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
  db: Db;
  principal: AgentPrincipal;
  authorization: string;
}) {
  const { app, principal, authorization, db } = options;
  const makeServer = () => {
  const server = new McpServer({ name: 'teamshelf', version: '0.2.0' });

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: unknown): Promise<RestReply> => {
    const requestOptions: InjectOptions = {
      method,
      url: `/api${path}`,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      headers: { authorization, 'x-requested-with': 'TeamShelf', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
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
    const readOnly = new Set(['whoami','list_spaces','list_documents','search_documents','get_document','get_revisions','get_revision','export_document','list_members','list_invitations','list_audit','list_my_proposals','get_my_proposal','list_document_comments','get_document_workflow']);
    const destructive = new Set(['update_document','set_space_access','set_document_access','delete_document','restore_document','update_space','delete_space','rename_team','change_member_role','remove_member','cancel_invitation','propose_document_delete','propose_document_restore','withdraw_my_proposal','set_document_workflow','resolve_comment']);
    const annotations: ToolAnnotations = { readOnlyHint: readOnly.has(name), destructiveHint: destructive.has(name), openWorldHint: false };
    const inputSchema = name === 'whoami' || name === 'list_teams' || shape.teamId
      ? shape : { ...shape, teamId: Id.optional() };
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      const input = args as ToolInput;
      if (typeof input.teamId === 'string') {
        let resourceTeamId: string | undefined;
        if (typeof input.spaceId === 'string') resourceTeamId = (db.prepare('SELECT team_id FROM spaces WHERE id=?').get(input.spaceId) as { team_id: string } | undefined)?.team_id;
        else if (typeof input.documentId === 'string') resourceTeamId = (db.prepare('SELECT s.team_id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=?').get(input.documentId) as { team_id: string } | undefined)?.team_id;
        else if (typeof input.proposalId === 'string') resourceTeamId = (db.prepare('SELECT team_id FROM proposals WHERE id=?').get(input.proposalId) as { team_id: string } | undefined)?.team_id;
        else if (typeof input.threadId === 'string') resourceTeamId = (db.prepare('SELECT s.team_id FROM document_comments c JOIN documents d ON d.id=c.document_id JOIN spaces s ON s.id=d.space_id WHERE c.id=?').get(input.threadId) as { team_id: string } | undefined)?.team_id;
        else if (typeof input.invitationId === 'string') resourceTeamId = (db.prepare('SELECT team_id FROM invitations WHERE id=?').get(input.invitationId) as { team_id: string } | undefined)?.team_id;
        if (resourceTeamId !== undefined && resourceTeamId !== input.teamId) return teamError('资源不属于所选团队，或当前账号无权访问。') as never;
        if (resourceTeamId === undefined && ['spaceId', 'documentId', 'proposalId', 'threadId', 'invitationId'].some(key => typeof input[key] === 'string')) return teamError('资源不属于所选团队，或当前账号无权访问。') as never;
        if (resourceTeamId !== undefined && !selectTeam(input.teamId).teamId) return teamError('资源不属于所选团队，或当前账号无权访问。') as never;
      }
      return callback(input) as never;
    });
  };

  const teamArgs = { teamId: Id.optional() };
  const selectTeam = (teamId?: unknown): { teamId?: string; error?: string } => {
    const rows = db.prepare('SELECT t.id,m.role FROM teams t JOIN members m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.created_at,t.name').all(principal.userId) as Array<{ id: string; role: string }>;
    if (typeof teamId === 'string') return rows.some(row => row.id === teamId) ? { teamId } : { error: '你当前不是所选团队的成员。先调用 list_teams 查看可用团队。' };
    if (rows.length === 1) return { teamId: rows[0].id };
    if (rows.length === 0) return { error: '此账号目前不属于任何团队。' };
    return { error: '此操作需要 teamId。请先调用 list_teams 选择一个团队。' };
  };
  const teamError = (message: string) => ({ ...resultText({ error: { code: 'TEAM_SELECTION_REQUIRED', message } }), isError: true });
  const teamRole = (role: string) => role === 'owner' || role === 'admin' ? 2 : role === 'editor' ? 1 : 0;
  const roles = db.prepare('SELECT role FROM members WHERE user_id=?').all(principal.userId) as Array<{ role: string }>;
  const canWriteAny = roles.some(row => teamRole(row.role) >= 1);
  const canManageAny = roles.some(row => teamRole(row.role) >= 2);

  register('whoami', '查看当前账号及其可访问团队。', emptyArgs, () => run('GET', '/agent/identity'));
  register('list_teams', '列出当前账号所属团队及当前角色。', emptyArgs, () => run('GET', '/agent/identity'));
  register('list_spaces', '列出所选团队中可访问的知识库，可用offset/limit继续分页。', { ...teamArgs, ...pageArgs }, ({ teamId, offset, limit }) => {
    const selected = selectTeam(teamId); return selected.teamId ? run('GET', `/teams/${selected.teamId}/spaces?offset=${offset ?? 0}&limit=${limit ?? 100}`) : Promise.resolve(teamError(selected.error!));
  });
  register('list_documents', '列出知识库中可访问的文档，可用offset/limit继续分页。', spaceArgs, ({ spaceId, offset, limit }) => run('GET', `/spaces/${spaceId}/documents?offset=${offset ?? 0}&limit=${limit ?? 100}`));
  register('search_documents', '在所选团队或指定知识库范围内搜索，可用offset/limit继续分页。', { ...teamArgs, ...searchArgs }, async ({ teamId, query, spaceId, offset, limit }) => {
    const selected = selectTeam(teamId); if (!selected.teamId) return teamError(selected.error!);
    const params = new URLSearchParams({ q: String(query), offset: String(offset ?? 0), limit: String(limit ?? 100) });
    if (spaceId) params.set('spaceId', String(spaceId));
    const reply = await call('GET', `/teams/${selected.teamId}/search?${params.toString()}`);
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

  register('list_my_proposals', '列出当前账号本人提交的提案。', { ...teamArgs, ...pageArgs, status: z.enum(['pending','approved','rejected','withdrawn','conflicted']).optional() }, async ({ teamId, offset, limit, status }) => {
    const selected = selectTeam(teamId); if (!selected.teamId) return teamError(selected.error!);
    const params=new URLSearchParams({mine:'true',offset:String(offset??0),limit:String(limit??100)});if(status)params.set('status',String(status));
    return run('GET','/teams/'+selected.teamId+'/proposals?'+params.toString());
  });
  register('get_my_proposal', '读取自己提交的提案详情。', { proposalId: Id }, ({ proposalId }) => run('GET','/proposals/'+proposalId));
  register('list_document_comments', '读取当前可见文档的讨论串及回复。', { ...docArgs, ...pageArgs }, ({ documentId, offset, limit }) => run('GET','/documents/'+documentId+'/comments?offset='+(offset??0)+'&limit='+(limit??50)));
  register('get_document_workflow', '读取文档负责人、复核时间和到期时间。', docArgs, ({ documentId }) => run('GET','/documents/'+documentId+'/workflow'));
  if (canWriteAny) {
    register('create_document', '在知识库中创建 Markdown 文档。权限默认为继承知识库。', {
      spaceId: Id, parentId: Id.optional(), title: nonEmpty.max(200), markdown: z.string().max(500 * 1024).optional(),
    }, ({ spaceId, parentId, title, markdown }) => run('POST', `/spaces/${spaceId}/documents`, { title, body: markdown ?? '', parentId, visibility: 'inherit', grants: [] }));
    register('update_document', '更新文档标题和 Markdown 正文，必须提供当前版本号。', {
      documentId: Id, title: nonEmpty.max(200), markdown: z.string().max(500 * 1024), version: z.number().int().positive(),
    }, ({ documentId, title, markdown, version }) => run('PATCH', `/documents/${documentId}`, { title, body: markdown, version }));
  }

    const commentSource = z.discriminatedUnion('kind', [
      z.object({ kind:z.literal('published'), version:z.number().int().positive() }).strict(),
      z.object({ kind:z.literal('draft'), draftId:Id, seq:z.number().int().nonnegative() }).strict(),
      z.object({ kind:z.literal('proposal'), proposalId:Id }).strict(),
    ]);
    register('propose_document_create', '在启用复核的知识库提交新文档提案；不会直接创建正式文档。', { spaceId:Id, parentId:Id.optional(), title:nonEmpty.max(200), markdown:z.string().max(500*1024).optional() }, ({spaceId,parentId,title,markdown}) => run('POST','/spaces/'+spaceId+'/proposals',{kind:'create',title,body:markdown??'',parentId,visibility:'inherit',grants:[]}));
    register('propose_document_update', '提交文档标题和正文修改供负责人复核，不直接修改正式内容。', {documentId:Id,version:z.number().int().positive(),title:nonEmpty.max(200),markdown:z.string().max(500*1024)}, ({documentId,version,title,markdown}) => run('POST','/documents/'+documentId+'/proposals',{kind:'update',baseVersion:version,title,body:markdown}));
    register('withdraw_my_proposal', '撤回自己尚待处理的提案。', {proposalId:Id}, ({proposalId}) => run('POST','/proposals/'+proposalId+'/withdraw',{}));
    register('add_document_comment', '在可编辑文档的指定版本、草稿或本人提案上添加讨论。', {documentId:Id,source:commentSource,quote:z.string().max(1000),anchor:z.object({paragraphIndex:z.number().int().nonnegative(),startOffset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative()}).strict(),body:nonEmpty.max(2000),mentionUserIds:z.array(Id).max(50).optional()}, ({documentId,source,quote,anchor,body,mentionUserIds}) => run('POST','/documents/'+documentId+'/comments',{source,quote,anchor,body,mentionUserIds:mentionUserIds??[]}));
    register('reply_to_comment', '回复一条当前可访问且未解决的讨论。', {threadId:Id,body:nonEmpty.max(2000),mentionUserIds:z.array(Id).max(50).optional()}, ({threadId,body,mentionUserIds}) => run('POST','/comments/'+threadId+'/replies',{body,mentionUserIds:mentionUserIds??[]}));
    register('resolve_comment', '解决或重新打开一条讨论；需当前文档编辑权限或管理权限。', {threadId:Id,resolved:z.boolean()}, ({threadId,resolved}) => run('PATCH','/comments/'+threadId,{resolved}));
    register('mark_document_reviewed', '记录当前负责人已完成文档复核。', {documentId:Id,metadataVersion:z.number().int().nonnegative()}, ({documentId,metadataVersion}) => run('POST','/documents/'+documentId+'/workflow/mark-reviewed',{metadataVersion}));
  if (canManageAny) {
    register('propose_document_restore', '提交将文档恢复到指定历史版本的提案。', {documentId:Id,version:z.number().int().positive(),revisionId:Id}, ({documentId,version,revisionId}) => run('POST','/documents/'+documentId+'/proposals',{kind:'restore',baseVersion:version,revisionId}));
    register('propose_document_delete', '提交删除文档的提案供负责人复核。', {documentId:Id,version:z.number().int().positive()}, ({documentId,version}) => run('POST','/documents/'+documentId+'/proposals',{kind:'delete',baseVersion:version}));
    register('set_document_workflow', '设置文档负责人、复核日期和到期日期；不更改正文版本。', {documentId:Id,responsibleUserId:Id.nullable(),reviewAt:z.string().datetime({offset:true}).nullable(),dueAt:z.string().datetime({offset:true}).nullable(),metadataVersion:z.number().int().nonnegative()}, ({documentId,responsibleUserId,reviewAt,dueAt,metadataVersion}) => run('PATCH','/documents/'+documentId+'/workflow',{responsibleUserId,reviewAt,dueAt,metadataVersion}));    const accessSchema = { visibility: z.enum(['team', 'restricted']), grants: z.array(z.object({ userId: Id, role: z.enum(['viewer', 'editor']) }).strict()).max(500) };
    const docAccessSchema = { visibility: z.enum(['inherit', 'restricted']), grants: z.array(z.object({ userId: Id, role: z.enum(['viewer', 'editor']) }).strict()).max(500) };
    register('set_space_access', '设置知识库可见性和成员授权。', { spaceId: Id, ...accessSchema }, ({ spaceId, visibility, grants }) => run('PUT', `/spaces/${spaceId}/access`, { visibility, grants }));
    register('set_document_access', '设置文档可见性和成员授权。', { documentId: Id, ...docAccessSchema }, ({ documentId, visibility, grants }) => run('PUT', `/documents/${documentId}/access`, { visibility, grants }));
    register('delete_document', '删除文档。', docArgs, ({ documentId }) => run('DELETE', `/documents/${documentId}`));
    register('restore_document', '恢复历史版本为新版本。', { documentId: Id, revisionId: Id, version: z.number().int().positive() }, ({ documentId, revisionId, version }) => run('POST', `/documents/${documentId}/revisions/${revisionId}/restore`, { version }));
    {
      register('create_space', '在所选团队创建知识库。', { ...teamArgs, name: nonEmpty.max(200), description: z.string().max(2000).optional() }, ({ teamId, name, description }) => { const selected = selectTeam(teamId); return selected.teamId ? run('POST', `/teams/${selected.teamId}/spaces`, { name, description: description ?? '', visibility: 'team', grants: [] }) : Promise.resolve(teamError(selected.error!)); });
      register('update_space', '修改知识库名称或说明。', { spaceId: Id, name: nonEmpty.max(200).optional(), description: z.string().max(2000).optional() }, ({ spaceId, name, description }) => run('PATCH', `/spaces/${spaceId}`, { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) }));
      register('delete_space', '删除空知识库。', spaceArgs, ({ spaceId }) => run('DELETE', `/spaces/${spaceId}`));
      register('rename_team', '修改所选团队名称。', { ...teamArgs, name: nonEmpty.max(100) }, ({ teamId, name }) => { const selected = selectTeam(teamId); return selected.teamId ? run('PATCH', `/teams/${selected.teamId}`, { name }) : Promise.resolve(teamError(selected.error!)); });
      register('list_members', '列出所选团队成员。', teamArgs, ({ teamId }) => { const selected = selectTeam(teamId); return selected.teamId ? run('GET', `/teams/${selected.teamId}/members`) : Promise.resolve(teamError(selected.error!)); });
      register('change_member_role', '修改所选团队成员角色。', { ...teamArgs, userId: Id, role: z.enum(['admin', 'editor', 'viewer']) }, ({ teamId, userId, role }) => { const selected = selectTeam(teamId); return selected.teamId ? run('PATCH', `/teams/${selected.teamId}/members/${userId}`, { role }) : Promise.resolve(teamError(selected.error!)); });
      register('remove_member', '从所选团队移除成员。', { ...teamArgs, userId: Id }, ({ teamId, userId }) => { const selected = selectTeam(teamId); return selected.teamId ? run('DELETE', `/teams/${selected.teamId}/members/${userId}`) : Promise.resolve(teamError(selected.error!)); });
      register('list_invitations', '列出所选团队待处理邀请。', teamArgs, ({ teamId }) => { const selected = selectTeam(teamId); return selected.teamId ? run('GET', `/teams/${selected.teamId}/invitations`) : Promise.resolve(teamError(selected.error!)); });
      register('invite_member', '邀请成员加入所选团队。', { ...teamArgs, email: z.string().trim().email().max(254), role: z.enum(['admin', 'editor', 'viewer']) }, ({ teamId, email, role }) => { const selected = selectTeam(teamId); return selected.teamId ? run('POST', `/teams/${selected.teamId}/invitations`, { email, role }) : Promise.resolve(teamError(selected.error!)); });
      register('cancel_invitation', '取消所选团队邀请。', { ...teamArgs, invitationId: Id }, ({ teamId, invitationId }) => { const selected = selectTeam(teamId); return selected.teamId ? run('DELETE', `/teams/${selected.teamId}/invitations/${invitationId}`) : Promise.resolve(teamError(selected.error!)); });
      register('list_audit', '查看所选团队最近审计事件。', teamArgs, ({ teamId }) => { const selected = selectTeam(teamId); return selected.teamId ? run('GET', `/teams/${selected.teamId}/audit`) : Promise.resolve(teamError(selected.error!)); });
    }
  }
  return server;
  };
  return createMcpHandler(makeServer, { responseMode: 'json' });
}
