import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Document, DocumentSummary, Grant, Revision, Space, Visibility } from '../shared/types.js';
import { requireUserId } from './auth.js';
import { getDocumentAccess, getSpaceAccess, listVisibleDocumentIds } from './acl.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound, reviewRequired } from './errors.js';
import { isoNow } from './security.js';
import { hasExplicitPage, paginate, parsePage } from './pagination.js';
import { validateBody } from './validation.js';

const IdSchema = z.string().uuid();
const TitleSchema = z.string().min(1).max(200).refine((value) => value.trim().length > 0).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(100), spaceId: IdSchema.optional(), offset: z.coerce.number().int().min(0).max(10000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const RevisionListQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(100), metadataOnly: z.coerce.boolean().optional().default(false) }).strict();
const GrantSchema = z.object({ userId: IdSchema, role: z.enum(['viewer', 'editor']) }).strict();
const GrantsSchema = z.array(GrantSchema).max(500).superRefine((grants, context) => {
  const users = new Set<string>();
  grants.forEach((grant, index) => {
    if (users.has(grant.userId)) context.addIssue({ code: 'custom', path: [index, 'userId'], message: 'Duplicate grant.' });
    users.add(grant.userId);
  });
});
const CreateSpaceSchema = z.object({
  name: TitleSchema,
  description: z.string().max(2000).optional().default(''),
  visibility: z.enum(['team', 'restricted']).optional().default('team'),
  grants: GrantsSchema.optional().default([]),
}).strict();
const UpdateSpaceSchema = z.object({
  name: TitleSchema.optional(),
  description: z.string().max(2000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const SpaceAccessSchema = z.object({ visibility: z.enum(['team', 'restricted']), grants: GrantsSchema }).strict();
const CreateDocumentSchema = z.object({
  title: TitleSchema,
  body: z.string().max(500 * 1024).optional().default(''),
  visibility: z.enum(['inherit', 'restricted']).optional().default('inherit'),
  grants: GrantsSchema.optional().default([]),
}).strict();
const UpdateDocumentSchema = z.object({ title: TitleSchema, body: z.string().max(500 * 1024), version: z.number().int().positive() }).strict();
const DocumentAccessSchema = z.object({ visibility: z.enum(['inherit', 'restricted']), grants: GrantsSchema }).strict();
const RestoreSchema = z.object({ version: z.number().int().positive() }).strict();
const SpaceParamsSchema = z.object({ spaceId: IdSchema }).strict();
const TeamParamsSchema = z.object({ teamId: IdSchema }).strict();
const DocumentParamsSchema = z.object({ id: IdSchema }).strict();
const RevisionParamsSchema = z.object({ id: IdSchema, revisionId: IdSchema }).strict();

interface Params { teamId: string; spaceId: string; id: string; revisionId: string }
interface SpaceRow { id: string; team_id: string; name: string; description: string; visibility: Visibility }
interface DocumentRow {
  id: string; space_id: string; title: string; body: string; visibility: 'inherit' | 'restricted'; version: number;
  created_by: string; created_at: string; updated_by: string; updated_at: string; updated_by_name: string;
}
interface MemberRow { role: 'owner' | 'admin' | 'editor' | 'viewer' }
interface GrantInput { userId: string; role: 'viewer' | 'editor' }

function validateParams(schema: z.ZodType) {
  return async (request: FastifyRequest): Promise<void> => {
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) throw badRequest('资源标识格式无效。');
    (request as FastifyRequest & { params: unknown }).params = parsed.data;
  };
}

function actor(db: AppContext['db'], request: FastifyRequest): { id: string; name: string } {
  const userId = requireUserId(db, request);
  const user = db.prepare('SELECT id,name FROM users WHERE id=?').get(userId) as { id: string; name: string } | undefined;
  if (!user) throw notFound();
  return user;
}

function requireTeamRole(db: AppContext['db'], userId: string, teamId: string): MemberRow['role'] {
  const row = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, userId) as MemberRow | undefined;
  if (!row) throw notFound();
  return row.role;
}

function isManager(role: string): boolean { return role === 'owner' || role === 'admin'; }

function audit(db: AppContext['db'], teamId: string, userId: string, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), teamId, userId, action, targetType, targetId, isoNow(), JSON.stringify(details));
}

function assertGrantMembers(db: AppContext['db'], teamId: string, grants: GrantInput[]): void {
  if (grants.length === 0) return;
  const ids = [...new Set(grants.map(({ userId }) => userId))];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT user_id FROM members WHERE team_id=? AND user_id IN (${placeholders})`)
    .all(teamId, ...ids) as Array<{ user_id: string }>;
  if (rows.length !== ids.length) throw badRequest('授权对象必须是当前团队成员。');
}

function replaceGrants(db: AppContext['db'], table: 'space_grants' | 'document_grants', keyColumn: 'space_id' | 'document_id', resourceId: string, grants: GrantInput[]): void {
  db.prepare(`DELETE FROM ${table} WHERE ${keyColumn}=?`).run(resourceId);
  const insert = db.prepare(`INSERT INTO ${table}(${keyColumn},user_id,role) VALUES(?,?,?)`);
  for (const grant of grants) insert.run(resourceId, grant.userId, grant.role);
}

function getSpace(db: AppContext['db'], spaceId: string): SpaceRow | undefined {
  return db.prepare('SELECT id,team_id,name,description,visibility FROM spaces WHERE id=?').get(spaceId) as SpaceRow | undefined;
}

function getDocument(db: AppContext['db'], id: string): DocumentRow | undefined {
  return db.prepare(`SELECT d.id,d.space_id,d.title,d.body,d.visibility,d.version,d.created_by,d.created_at,d.updated_by,d.updated_at,u.name AS updated_by_name
    FROM documents d JOIN users u ON u.id=d.updated_by WHERE d.id=?`).get(id) as DocumentRow | undefined;
}

function grantsFor(db: AppContext['db'], table: 'space_grants' | 'document_grants', keyColumn: 'space_id' | 'document_id', resourceId: string): Grant[] {
  return db.prepare(`SELECT user_id AS userId,role FROM ${table} WHERE ${keyColumn}=? ORDER BY user_id`)
    .all(resourceId) as unknown as Grant[];
}

function toSpace(row: SpaceRow, access: NonNullable<ReturnType<typeof getSpaceAccess>>): Space {
  return { id: row.id, teamId: row.team_id, name: row.name, description: row.description,
    visibility: row.visibility, canManage: access.canManage, canEdit: access.canEdit };
}

function excerpt(body: string, limit = 240): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function toSummary(row: DocumentRow, access: NonNullable<ReturnType<typeof getDocumentAccess>>): DocumentSummary {
  return { id: row.id, spaceId: row.space_id, title: row.title, excerpt: excerpt(row.body), visibility: row.visibility,
    version: row.version, updatedAt: row.updated_at, updatedByName: row.updated_by_name,
    canEdit: access.canEdit, canManage: access.canManage };
}

function toDocument(db: AppContext['db'], row: DocumentRow, access: NonNullable<ReturnType<typeof getDocumentAccess>>): Document {
  return { ...toSummary(row, access), body: row.body, createdAt: row.created_at, createdBy: row.created_by,
    ...(access.canManage ? { grants: grantsFor(db, 'document_grants', 'document_id', row.id) } : {}) };
}

function visibleSpace(db: AppContext['db'], userId: string, spaceId: string) {
  const row = getSpace(db, spaceId);
  const access = getSpaceAccess(db, userId, spaceId);
  if (!row || !access?.canRead) throw notFound();
  return { row, access };
}

function visibleDocument(db: AppContext['db'], userId: string, id: string) {
  const access = getDocumentAccess(db, userId, id);
  if (!access?.canRead) throw notFound();
  const row = getDocument(db, id);
  if (!row) throw notFound();
  return { row, access };
}

function requireManager(canManage: boolean): void {
  if (!canManage) throw forbidden();
}

function ensureDirectChangesAllowed(db: AppContext['db'], spaceId: string): void {
  const row = db.prepare('SELECT require_review FROM spaces WHERE id=?').get(spaceId) as { require_review: number } | undefined;
  if (row?.require_review === 1) throw reviewRequired();
}

function requireBodyBytes(body: string): void {
  if (Buffer.byteLength(body, 'utf8') > 500 * 1024) throw badRequest('文档正文不能超过 500 KB。');
}

function accessResponse(db: AppContext['db'], visibility: string, table: 'space_grants' | 'document_grants', key: 'space_id' | 'document_id', id: string) {
  return { visibility, grants: grantsFor(db, table, key, id) };
}

export function registerContentRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get('/teams/:teamId/spaces', { config: { agentAccess: { scope: 'read', operation: 'space.read', teamParam: 'teamId', allowSpaceBound: true } }, preValidation: validateParams(TeamParamsSchema) }, async (request) => {
    const { teamId } = request.params as Params;
    const user = actor(db, request);
    requireTeamRole(db, user.id, teamId!);
    const page = parsePage(request.query);
    const rows = db.prepare('SELECT id,team_id,name,description,visibility FROM spaces WHERE team_id=? ORDER BY name,id').all(teamId) as unknown as SpaceRow[];
    const spaces = rows.filter((row) => !request.agentPrincipal?.spaceId || row.id === request.agentPrincipal.spaceId).flatMap((row) => {
      const access = getSpaceAccess(db, user.id, row.id);
      return access?.canRead ? [toSpace(row, access)] : [];
    });
    const pageResult = paginate(spaces, page);
    return { spaces: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.post('/teams/:teamId/spaces', { config: { agentAccess: { scope: 'manage', operation: 'team.manage', teamParam: 'teamId' } }, preValidation: [validateParams(TeamParamsSchema), validateBody(CreateSpaceSchema)] }, async (request, reply) => {
    const { teamId } = request.params as Params;
    const input = request.body as z.infer<typeof CreateSpaceSchema>;
    const user = actor(db, request);
    const role = requireTeamRole(db, user.id, teamId!);
    if (!isManager(role)) throw forbidden();
    if (input.visibility === 'team' && input.grants.length) throw badRequest('team 空间不能包含单独授权。');
    assertGrantMembers(db, teamId!, input.grants);
    const id = randomUUID();
    const now = isoNow();
    transaction(db, () => {
      db.prepare('INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, teamId, input.name.trim(), input.description, input.visibility, user.id, now);
      replaceGrants(db, 'space_grants', 'space_id', id, input.grants);
      audit(db, teamId!, user.id, 'space.create', 'space', id, { name: input.name.trim() });
    });
    const row = getSpace(db, id)!;
    return reply.code(201).send({ space: toSpace(row, getSpaceAccess(db, user.id, id)!) });
  });

  app.patch('/spaces/:spaceId', { config: { agentAccess: { scope: 'manage', operation: 'space.manage', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: [validateParams(SpaceParamsSchema), validateBody(UpdateSpaceSchema)] }, async (request) => {
    const { spaceId } = request.params as Params;
    const input = request.body as z.infer<typeof UpdateSpaceSchema>;
    const user = actor(db, request);
    const { row, access } = visibleSpace(db, user.id, spaceId!);
    requireManager(access.canManage);
    const name = input.name?.trim() ?? row.name;
    const description = input.description ?? row.description;
    transaction(db, () => {
      db.prepare('UPDATE spaces SET name=?,description=? WHERE id=?').run(name, description, spaceId);
      audit(db, row.team_id, user.id, 'space.update', 'space', spaceId!, { name });
    });
    return { space: toSpace(getSpace(db, spaceId!)!, getSpaceAccess(db, user.id, spaceId!)!) };
  });

  app.delete('/spaces/:spaceId', { config: { agentAccess: { scope: 'manage', operation: 'space.manage', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: validateParams(SpaceParamsSchema) }, async (request) => {
    const { spaceId } = request.params as Params;
    const user = actor(db, request);
    const row = getSpace(db, spaceId!);
    const access = getSpaceAccess(db, user.id, spaceId!);
    if (!row || !access?.canRead) throw notFound();
    requireManager(access.canManage);
    if (db.prepare('SELECT 1 FROM documents WHERE space_id=? LIMIT 1').get(spaceId)) throw conflict('空间中仍有文档，无法删除。');
    transaction(db, () => {
      audit(db, row.team_id, user.id, 'space.delete', 'space', spaceId!, { name: row.name });
      db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE space_id=? AND revoked_at IS NULL').run(isoNow(), spaceId);
      db.prepare('DELETE FROM spaces WHERE id=?').run(spaceId);
    });
    return { ok: true };
  });

  app.get('/spaces/:spaceId/access', { config: { agentAccess: { scope: 'manage', operation: 'space.manage', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: validateParams(SpaceParamsSchema) }, async (request) => {
    const { spaceId } = request.params as Params;
    const user = actor(db, request);
    const { row, access } = visibleSpace(db, user.id, spaceId!);
    requireManager(access.canManage);
    return accessResponse(db, row.visibility, 'space_grants', 'space_id', spaceId!);
  });

  app.put('/spaces/:spaceId/access', { config: { agentAccess: { scope: 'manage', operation: 'space.manage', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: [validateParams(SpaceParamsSchema), validateBody(SpaceAccessSchema)] }, async (request) => {
    const { spaceId } = request.params as Params;
    const input = request.body as z.infer<typeof SpaceAccessSchema>;
    const user = actor(db, request);
    const { row, access } = visibleSpace(db, user.id, spaceId!);
    requireManager(access.canManage);
    if (input.visibility === 'team' && input.grants.length) throw badRequest('team 空间不能包含单独授权。');
    assertGrantMembers(db, row.team_id, input.grants);
    transaction(db, () => {
      db.prepare('UPDATE spaces SET visibility=? WHERE id=?').run(input.visibility, spaceId);
      replaceGrants(db, 'space_grants', 'space_id', spaceId!, input.grants);
      audit(db, row.team_id, user.id, 'space.access.update', 'space', spaceId!, { visibility: input.visibility, grantCount: input.grants.length });
    });
    return accessResponse(db, input.visibility, 'space_grants', 'space_id', spaceId!);
  });

  app.get('/spaces/:spaceId/documents', { config: { agentAccess: { scope: 'read', operation: 'document.read', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: validateParams(SpaceParamsSchema) }, async (request) => {
    const { spaceId } = request.params as Params;
    const user = actor(db, request);
    visibleSpace(db, user.id, spaceId!);
    const page = parsePage(request.query);
    const candidates = db.prepare(`SELECT d.id,d.space_id,d.title,d.body,d.visibility,d.version,d.created_by,d.created_at,d.updated_by,d.updated_at,u.name AS updated_by_name
      FROM documents d JOIN users u ON u.id=d.updated_by WHERE d.space_id=? ORDER BY d.updated_at DESC,d.id`).all(spaceId) as unknown as DocumentRow[];
    const documents = candidates.flatMap((row) => {
      const access = getDocumentAccess(db, user.id, row.id);
      return access?.canRead ? [toSummary(row, access)] : [];
    });
    const pageResult = paginate(documents, page);
    return { documents: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.post('/spaces/:spaceId/documents', { config: { agentAccess: { scope: 'write', operation: 'document.write', spaceParam: 'spaceId', allowSpaceBound: true } }, preValidation: [validateParams(SpaceParamsSchema), validateBody(CreateDocumentSchema)] }, async (request, reply) => {
    const { spaceId } = request.params as Params;
    const input = request.body as z.infer<typeof CreateDocumentSchema>;
    const user = actor(db, request);
    const { access } = visibleSpace(db, user.id, spaceId!);
    ensureDirectChangesAllowed(db, spaceId!);
    if (!access.canEdit) throw forbidden();
    if (request.agentPrincipal && (input.visibility === 'restricted' || input.grants.length > 0) && (request.agentPrincipal.scope !== 'manage' || !access.canManage)) throw forbidden('Agent 凭据需要当前 manage 权限才能设置文档访问权限。');
    requireBodyBytes(input.body);
    if (input.visibility === 'restricted' && !access.canManage) throw forbidden();
    if (input.visibility === 'inherit' && input.grants.length) throw badRequest('inherit 文档不能包含单独授权。');
    assertGrantMembers(db, access.teamId, input.grants);
    const id = randomUUID();
    const revisionId = randomUUID();
    const now = isoNow();
    transaction(db, () => {
      db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at)
        VALUES(?,?,?,?,?,1,?,?,?,?)`).run(id, spaceId, input.title.trim(), input.body, input.visibility, user.id, now, user.id, now);
      replaceGrants(db, 'document_grants', 'document_id', id, input.grants);
      db.prepare(`INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name)
        VALUES(?,?,1,?,?,?,?,?)`).run(revisionId, id, input.title.trim(), input.body, now, user.id, user.name);
      audit(db, access.teamId, user.id, 'document.create', 'document', id, { title: input.title.trim() });
    });
    const row = getDocument(db, id)!;
    return reply.code(201).send({ document: toDocument(db, row, getDocumentAccess(db, user.id, id)!) });
  });

  app.get('/documents/:id', { config: { agentAccess: { scope: 'read', operation: 'document.read', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(DocumentParamsSchema) }, async (request) => {
    const { id } = request.params as Params;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    return { document: toDocument(db, row, access) };
  });

  app.patch('/documents/:id', { config: { agentAccess: { scope: 'write', operation: 'document.write', documentParam: 'id', allowSpaceBound: true } }, preValidation: [validateParams(DocumentParamsSchema), validateBody(UpdateDocumentSchema)] }, async (request) => {
    const { id } = request.params as Params;
    const input = request.body as z.infer<typeof UpdateDocumentSchema>;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    ensureDirectChangesAllowed(db, access.spaceId);
    if (!access.canEdit) throw forbidden();
    requireBodyBytes(input.body);
    const title = input.title.trim();
    const now = isoNow();
    transaction(db, () => {
      const latest = db.prepare('SELECT version FROM documents WHERE id=?').get(id) as { version: number } | undefined;
      if (!latest || latest.version !== input.version) throw conflict('文档已被其他成员更新，请刷新后重试。');
      if (row.title === title && row.body === input.body) return;
      const nextVersion = input.version + 1;
      const changed = db.prepare('UPDATE documents SET title=?,body=?,version=?,updated_by=?,updated_at=? WHERE id=? AND version=?')
        .run(title, input.body, nextVersion, user.id, now, id, input.version);
      if (Number(changed.changes) !== 1) throw conflict('文档已被其他成员更新，请刷新后重试。');
      db.prepare(`INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), id, nextVersion, title, input.body, now, user.id, user.name);
      audit(db, access.teamId, user.id, 'document.update', 'document', id!, { version: nextVersion, title });
    });
    const updated = getDocument(db, id!)!;
    return { document: toDocument(db, updated, getDocumentAccess(db, user.id, id!)!) };
  });

  app.delete('/documents/:id', { config: { agentAccess: { scope: 'manage', operation: 'document.manage', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(DocumentParamsSchema) }, async (request) => {
    const { id } = request.params as Params;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    requireManager(access.canManage);
    ensureDirectChangesAllowed(db, access.spaceId);
    transaction(db, () => {
      audit(db, access.teamId, user.id, 'document.delete', 'document', id!, { title: row.title });
      db.prepare('DELETE FROM documents WHERE id=?').run(id);
    });
    return { ok: true };
  });

  app.get('/documents/:id/access', { config: { agentAccess: { scope: 'manage', operation: 'document.manage', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(DocumentParamsSchema) }, async (request) => {
    const { id } = request.params as Params;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    requireManager(access.canManage);
    return accessResponse(db, row.visibility, 'document_grants', 'document_id', id!);
  });

  app.put('/documents/:id/access', { config: { agentAccess: { scope: 'manage', operation: 'document.manage', documentParam: 'id', allowSpaceBound: true } }, preValidation: [validateParams(DocumentParamsSchema), validateBody(DocumentAccessSchema)] }, async (request) => {
    const { id } = request.params as Params;
    const input = request.body as z.infer<typeof DocumentAccessSchema>;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    requireManager(access.canManage);
    if (input.visibility === 'inherit' && input.grants.length) throw badRequest('inherit 文档不能包含单独授权。');
    assertGrantMembers(db, access.teamId, input.grants);
    transaction(db, () => {
      db.prepare('UPDATE documents SET visibility=? WHERE id=?').run(input.visibility, id);
      replaceGrants(db, 'document_grants', 'document_id', id!, input.grants);
      audit(db, access.teamId, user.id, 'document.access.update', 'document', id!, { visibility: input.visibility, grantCount: input.grants.length });
    });
    const updated = getDocument(db, id!)!;
    return { document: toDocument(db, updated, getDocumentAccess(db, user.id, id!)!) };
  });

  app.get('/documents/:id/revisions', { config: { agentAccess: { scope: 'read', operation: 'document.read', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(DocumentParamsSchema) }, async (request) => {
    const { id } = request.params as Params;
    const user = actor(db, request);
    visibleDocument(db, user.id, id!);
    const parsed = RevisionListQuerySchema.safeParse(request.query);
    if (!parsed.success) throw badRequest('分页参数无效。');
    const page = { offset: parsed.data.offset, limit: parsed.data.limit };
    const metadataOnly = request.agentPrincipal !== undefined || parsed.data.metadataOnly;
    const revisions = metadataOnly
      ? db.prepare(`SELECT r.id,r.version,r.title,r.created_at AS createdAt,r.author_name AS authorName FROM revisions r WHERE r.document_id=? ORDER BY r.version DESC`).all(id) as Array<Omit<Revision, 'body'>>
      : db.prepare(`SELECT r.id,r.version,r.title,r.body,r.created_at AS createdAt,r.author_name AS authorName FROM revisions r WHERE r.document_id=? ORDER BY r.version DESC`).all(id) as unknown as Revision[];
    if (!request.agentPrincipal && !hasExplicitPage(request.query) && !parsed.data.metadataOnly) return { revisions };
    const pageResult = paginate(revisions, page);
    return { revisions: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.get('/documents/:id/revisions/:revisionId', { config: { agentAccess: { scope: 'read', operation: 'document.read', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(RevisionParamsSchema) }, async (request) => {
    const { id, revisionId } = request.params as Params;
    const user = actor(db, request);
    visibleDocument(db, user.id, id!);
    const revision = db.prepare(`SELECT r.id,r.version,r.title,r.body,r.created_at AS createdAt,r.author_name AS authorName FROM revisions r WHERE r.id=? AND r.document_id=?`)
      .get(revisionId, id) as Revision | undefined;
    if (!revision) throw notFound();
    return { revision };
  });
  app.post('/documents/:id/revisions/:revisionId/restore', { config: { agentAccess: { scope: 'manage', operation: 'document.manage', documentParam: 'id', allowSpaceBound: true } }, preValidation: [validateParams(RevisionParamsSchema), validateBody(RestoreSchema)] }, async (request) => {
    const { id, revisionId } = request.params as Params;
    const input = request.body as z.infer<typeof RestoreSchema>;
    const user = actor(db, request);
    const { row, access } = visibleDocument(db, user.id, id!);
    requireManager(access.canManage);
    ensureDirectChangesAllowed(db, access.spaceId);
    const revision = db.prepare(`SELECT title,body FROM revisions WHERE id=? AND document_id=?`)
      .get(revisionId, id) as { title: string; body: string } | undefined;
    if (!revision) throw notFound();
    requireBodyBytes(revision.body);
    const now = isoNow();
    transaction(db, () => {
      const latest = db.prepare('SELECT version FROM documents WHERE id=?').get(id) as { version: number } | undefined;
      if (!latest || latest.version !== input.version) throw conflict('文档已被其他成员更新，请刷新后重试。');
      const nextVersion = input.version + 1;
      const changed = db.prepare('UPDATE documents SET title=?,body=?,version=?,updated_by=?,updated_at=? WHERE id=? AND version=?')
        .run(revision.title, revision.body, nextVersion, user.id, now, id, input.version);
      if (Number(changed.changes) !== 1) throw conflict('文档已被其他成员更新，请刷新后重试。');
      db.prepare(`INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name)
        VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), id, nextVersion, revision.title, revision.body, now, user.id, user.name);
      audit(db, access.teamId, user.id, 'document.restore', 'document', id!, { version: nextVersion, revisionId });
    });
    const updated = getDocument(db, id!)!;
    return { document: toDocument(db, updated, getDocumentAccess(db, user.id, id!)!) };
  });

  app.get('/documents/:id/export', { config: { agentAccess: { scope: 'read', operation: 'document.read', documentParam: 'id', allowSpaceBound: true } }, preValidation: validateParams(DocumentParamsSchema) }, async (request, reply) => {
    const { id } = request.params as Params;
    const user = actor(db, request);
    const { row } = visibleDocument(db, user.id, id!);
    const fallback = row.title.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
    const filename = encodeURIComponent(`${row.title}.md`).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fallback}.md"; filename*=UTF-8''${filename}`)
      .send(row.body);
  });

  app.get('/teams/:teamId/search', { config: { agentAccess: { scope: 'read', operation: 'document.read', teamParam: 'teamId', allowSpaceBound: true } }, preValidation: validateParams(TeamParamsSchema) }, async (request) => {
    const { teamId } = request.params as Params;
    const user = actor(db, request);
    requireTeamRole(db, user.id, teamId!);
    const parsedQuery = SearchQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) throw badRequest('搜索词长度必须为 1 到 100 个字符，且不能包含额外字段。');
    const needle = parsedQuery.data.q.toLocaleLowerCase();
    const page = { offset: parsedQuery.data.offset, limit: parsedQuery.data.limit };
    const selectedSpaceId = parsedQuery.data.spaceId ?? request.agentPrincipal?.spaceId ?? undefined;
    if (parsedQuery.data.spaceId && request.agentPrincipal?.spaceId && parsedQuery.data.spaceId !== request.agentPrincipal.spaceId) throw notFound();
    if (selectedSpaceId) {
      const selectedSpace = db.prepare('SELECT team_id FROM spaces WHERE id=?').get(selectedSpaceId) as { team_id: string } | undefined;
      if (!selectedSpace || selectedSpace.team_id !== teamId) throw notFound();
      visibleSpace(db, user.id, selectedSpaceId);
    }
    const ids = listVisibleDocumentIds(db, user.id, teamId!);
    const matches: DocumentSummary[] = [];
    for (const id of ids) {
      const access = getDocumentAccess(db, user.id, id);
      if (!access?.canRead || (selectedSpaceId && access.spaceId !== selectedSpaceId)) continue;
      const row = getDocument(db, id);
      if (!row) continue;
      if (`${row.title}\n${row.body}`.toLocaleLowerCase().includes(needle)) matches.push(toSummary(row, access));
    }
    const pageResult = paginate(matches, page);
    return { documents: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.get('/teams/:teamId/audit', { config: { agentAccess: { scope: 'manage', operation: 'audit.read', teamParam: 'teamId' } }, preValidation: validateParams(TeamParamsSchema) }, async (request) => {
    const { teamId } = request.params as Params;
    const user = actor(db, request);
    const role = requireTeamRole(db, user.id, teamId!);
    if (!isManager(role)) throw forbidden();
    const page = parsePage(request.query);
    const rows = db.prepare(`SELECT e.id,e.actor_id,e.action,e.target_type,e.target_id,e.created_at,e.details_json,u.name AS actor_name
      FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.team_id=? ORDER BY e.created_at DESC,e.id DESC`)
      .all(teamId) as Array<{ id: string; actor_id: string | null; actor_name: string | null; action: string; target_type: string; target_id: string | null; created_at: string; details_json: string }>;
    const events = rows.map((row) => {
      let details: unknown = {};
      try { details = JSON.parse(row.details_json); } catch { details = {}; }
      return { id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action,
        targetType: row.target_type, targetId: row.target_id, createdAt: row.created_at, details };
    });
    const pageResult = paginate(events, page);
    return { events: pageResult.entries, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });
}
