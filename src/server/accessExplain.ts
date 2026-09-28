import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDocumentAccess, getSpaceAccess } from './acl.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { requireUserId } from './auth.js';
import { hasExplicitPage, paginate, parsePage } from './pagination.js';
import { validateBody, validateParams } from './validation.js';

const Id = z.string().uuid();
const SpaceParams = z.object({ spaceId: Id }).strict();
const DocumentParams = z.object({ id: Id }).strict();
const TeamParams = z.object({ teamId: Id }).strict();
const SubjectQuery = z.object({ userId: Id }).strict();
const Grant = z.object({ userId: Id, role: z.enum(['viewer', 'editor']) }).strict();
const Grants = z.array(Grant).max(500).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.userId)) context.addIssue({ code: 'custom', path: [index, 'userId'], message: 'Duplicate grant.' });
    seen.add(item.userId);
  });
});
const Page = z.object({ offset: z.number().int().min(0).max(10_000_000).optional().default(0), limit: z.number().int().min(1).max(100).optional().default(100) }).strict();
const SpacePreviewBody = z.object({ visibility: z.enum(['team', 'restricted']), grants: Grants, offset: z.number().int().min(0).max(10_000_000).optional().default(0), limit: z.number().int().min(1).max(100).optional().default(100) }).strict();
const DocumentPreviewBody = z.object({ visibility: z.enum(['inherit', 'restricted']), grants: Grants, offset: z.number().int().min(0).max(10_000_000).optional().default(0), limit: z.number().int().min(1).max(100).optional().default(100) }).strict();

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type Flags = { canRead: boolean; canEdit: boolean; canManage: boolean };
type Reason = { layer: 'team' | 'space' | 'document'; code: string; visibility?: string; grantRole?: string };
type MemberRow = { user_id: string; name: string; role: Role };
type GrantRow = { userId: string; role: 'viewer' | 'editor' };

function requireSessionUser(db: AppContext['db'], request: FastifyRequest): string {
  if (request.agentPrincipal) throw forbidden('此端点仅支持浏览器会话。');
  return requireUserId(db, request);
}

function managerForSpace(db: AppContext['db'], userId: string, spaceId: string) {
  const space = db.prepare('SELECT id,team_id,name,visibility,require_review FROM spaces WHERE id=?').get(spaceId) as { id: string; team_id: string; name: string; visibility: string; require_review: number } | undefined;
  const access = getSpaceAccess(db, userId, spaceId);
  if (!space || !access?.canRead) throw notFound();
  if (!access.canManage) throw forbidden();
  return { space, access };
}

function managerForDocument(db: AppContext['db'], userId: string, documentId: string) {
  const document = db.prepare(`SELECT d.id,d.space_id,d.title,d.visibility,s.team_id,s.name AS space_name
    FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=?`).get(documentId) as { id: string; space_id: string; title: string; visibility: string; team_id: string; space_name: string } | undefined;
  const access = getDocumentAccess(db, userId, documentId);
  if (!document || !access?.canRead) throw notFound();
  if (!access.canManage) throw forbidden();
  return { document, access };
}

function members(db: AppContext['db'], teamId: string): MemberRow[] {
  return db.prepare(`SELECT m.user_id,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.team_id=? ORDER BY m.user_id`).all(teamId) as MemberRow[];
}

function flags(value: Flags): Flags { return { canRead: value.canRead, canEdit: value.canEdit, canManage: value.canManage }; }
function changed(before: Flags, after: Flags): boolean {
  return before.canRead !== after.canRead || before.canEdit !== after.canEdit || before.canManage !== after.canManage;
}

function reasonsForSpace(db: AppContext['db'], userId: string, spaceId: string): Reason[] {
  const row = db.prepare(`SELECT s.visibility,m.role,(SELECT g.role FROM space_grants g WHERE g.space_id=s.id AND g.user_id=?) AS grant_role
    FROM spaces s JOIN members m ON m.team_id=s.team_id AND m.user_id=? WHERE s.id=?`)
    .get(userId,userId,spaceId) as {visibility:'team'|'restricted';role:Role;grant_role:'viewer'|'editor'|null}|undefined;
  if (!row) throw notFound();
  const manager = row.role === 'owner' || row.role === 'admin';
  const reasons: Reason[] = [{ layer:'team', code: manager ? 'team_manager' : `team_role_${row.role}` }];
  reasons.push({ layer:'space', code: row.visibility === 'team' ? 'space_team_visible' : manager ? 'space_manager_bypass' : row.grant_role ? 'space_grant' : 'space_restricted_no_grant', visibility:row.visibility, ...(row.grant_role ? {grantRole:row.grant_role} : {}) });
  return reasons;
}

function reasonsForDocument(db: AppContext['db'], userId: string, documentId: string): Reason[] {
  const row = db.prepare(`SELECT d.visibility AS document_visibility,s.id AS space_id,s.visibility AS space_visibility,m.role,
      (SELECT g.role FROM space_grants g WHERE g.space_id=s.id AND g.user_id=?) AS space_grant,
      (SELECT g.role FROM document_grants g WHERE g.document_id=d.id AND g.user_id=?) AS document_grant
    FROM documents d JOIN spaces s ON s.id=d.space_id JOIN members m ON m.team_id=s.team_id AND m.user_id=? WHERE d.id=?`)
    .get(userId,userId,userId,documentId) as {document_visibility:'inherit'|'restricted';space_id:string;space_visibility:'team'|'restricted';role:Role;space_grant:'viewer'|'editor'|null;document_grant:'viewer'|'editor'|null}|undefined;
  if (!row) throw notFound();
  const manager = row.role === 'owner' || row.role === 'admin';
  const reasons: Reason[] = [{ layer:'team', code: manager ? 'team_manager' : `team_role_${row.role}` }];
  reasons.push({ layer:'space', code: row.space_visibility === 'team' ? 'space_team_visible' : manager ? 'space_manager_bypass' : row.space_grant ? 'space_grant' : 'space_restricted_no_grant', visibility:row.space_visibility, ...(row.space_grant ? {grantRole:row.space_grant} : {}) });
  reasons.push({ layer:'document', code: row.document_visibility === 'inherit' ? 'document_inherits_space' : manager ? 'document_manager_bypass' : row.document_grant ? 'document_grant' : 'document_restricted_no_grant', visibility:row.document_visibility, ...(row.document_grant ? {grantRole:row.document_grant} : {}) });
  return reasons;
}

function requireMember(db: AppContext['db'], teamId: string, userId: string): void {
  if (!db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(teamId,userId)) throw notFound();
}

function validateGrants(db: AppContext['db'], teamId: string, grants: GrantRow[], visibility: string, inherited: boolean): void {
  if ((visibility === 'team' || inherited) && grants.length > 0) throw badRequest('此权限模式不能包含单独授权。');
  if (!grants.length) return;
  const ids = grants.map((item) => item.userId);
  const qs = ids.map(() => '?').join(',');
  const found = db.prepare(`SELECT user_id FROM members WHERE team_id=? AND user_id IN (${qs})`).all(teamId,...ids) as Array<{user_id:string}>;
  if (found.length !== ids.length) throw badRequest('授权对象必须是当前团队成员。');
}

function replaceGrants(db: AppContext['db'], table: 'space_grants'|'document_grants', key: 'space_id'|'document_id', id: string, grants: GrantRow[]): void {
  db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(id);
  const insert = db.prepare(`INSERT INTO ${table}(${key},user_id,role) VALUES(?,?,?)`);
  for (const grant of grants) insert.run(id,grant.userId,grant.role);
}

function documentImpact(db: AppContext['db'], userId: string, spaceId: string) {
  const docs = db.prepare('SELECT id FROM documents WHERE space_id=? ORDER BY id').all(spaceId) as Array<{id:string}>;
  let read = 0, edit = 0;
  for (const {id} of docs) {
    const access = getDocumentAccess(db,userId,id);
    if (access?.canRead) read++;
    if (access?.canEdit) edit++;
  }
  return { read, edit };
}

function withPreview<T>(db: AppContext['db'], action: () => T): T {
  db.exec('SAVEPOINT access_preview');
  try { return action(); }
  finally {
    db.exec('ROLLBACK TO access_preview');
    db.exec('RELEASE access_preview');
  }
}

function accessCounters() { return { membersChanged:0,readGained:0,readLost:0,editGained:0,editLost:0,documentsReadGained:0,documentsReadLost:0,documentsEditGained:0,documentsEditLost:0 }; }

export function registerAccessExplainRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get('/teams/:teamId/access/health', { preValidation: validateParams(TeamParams) }, async (request) => {
    const actorId = requireSessionUser(db, request);
    const { teamId } = request.params as z.infer<typeof TeamParams>;
    const manager = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, actorId) as { role: Role } | undefined;
    if (!manager) throw notFound();
    if (manager.role !== 'owner' && manager.role !== 'admin') throw forbidden();
    const { offset, limit } = parsePage(request.query);
    const allMembers = members(db, teamId);
    const spaces = db.prepare('SELECT id FROM spaces WHERE team_id=? ORDER BY id').all(teamId) as Array<{id:string}>;
    const docs = db.prepare('SELECT d.id,d.space_id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.team_id=? ORDER BY d.id').all(teamId) as Array<{id:string;space_id:string}>;
    const totals = { members: allMembers.length, spaces: spaces.length, documents: docs.length };
    const memberRows = allMembers.map((member) => {
      let spacesReadable = 0, spacesEditable = 0, documentsReadable = 0, documentsEditable = 0;
      for (const space of spaces) {
        const access = getSpaceAccess(db, member.user_id, space.id);
        if (access?.canRead) spacesReadable++;
        if (access?.canEdit) spacesEditable++;
      }
      for (const document of docs) {
        const access = getDocumentAccess(db, member.user_id, document.id);
        if (access?.canRead) documentsReadable++;
        if (access?.canEdit) documentsEditable++;
      }
      return { userId: member.user_id, name: member.name, teamRole: member.role, spacesReadable, spacesEditable, documentsReadable, documentsEditable };
    });
    const findings: Array<{code:string;resourceKind:'space'|'document';resourceId:string;userId?:string}> = [];
    const spaceGrants = db.prepare(`SELECT g.space_id AS resource_id,g.user_id,s.team_id FROM space_grants g JOIN spaces s ON s.id=g.space_id WHERE s.team_id=? ORDER BY g.space_id,g.user_id`).all(teamId) as Array<{resource_id:string;user_id:string;team_id:string}>;
    for (const grant of spaceGrants) {
      if (!db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(grant.team_id,grant.user_id)) findings.push({code:'grant_user_not_team_member',resourceKind:'space',resourceId:grant.resource_id,userId:grant.user_id});
    }
    const documentGrants = db.prepare(`SELECT g.document_id AS resource_id,g.user_id,d.space_id,s.team_id,s.visibility AS space_visibility FROM document_grants g JOIN documents d ON d.id=g.document_id JOIN spaces s ON s.id=d.space_id WHERE s.team_id=? ORDER BY g.document_id,g.user_id`).all(teamId) as Array<{resource_id:string;user_id:string;space_id:string;team_id:string;space_visibility:string}>;
    for (const grant of documentGrants) {
      const isMember = Boolean(db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(grant.team_id,grant.user_id));
      if (!isMember) findings.push({code:'grant_user_not_team_member',resourceKind:'document',resourceId:grant.resource_id,userId:grant.user_id});
      else if (grant.space_visibility === 'restricted' && !db.prepare('SELECT 1 FROM space_grants WHERE space_id=? AND user_id=?').get(grant.space_id,grant.user_id)) {
        const role = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(grant.team_id,grant.user_id) as {role:Role};
        if (role.role !== 'owner' && role.role !== 'admin') findings.push({code:'document_grant_blocked_by_space',resourceKind:'document',resourceId:grant.resource_id,userId:grant.user_id});
      }
    }
    const pageResult = paginate(memberRows, {offset,limit});
    return { members: pageResult.entries, totals, findings, hasMore: pageResult.hasMore, nextOffset: pageResult.nextOffset };
  });

  app.get('/spaces/:spaceId/review-policy', { preValidation: validateParams(SpaceParams) }, async (request) => {
    const userId = requireSessionUser(db, request);
    const { spaceId } = request.params as z.infer<typeof SpaceParams>;
    const { space } = managerForSpace(db,userId,spaceId);
    return { requireReview: space.require_review === 1 };
  });

  app.get('/spaces/:spaceId/access/explain', { preValidation: validateParams(SpaceParams) }, async (request) => {
    const userId = requireSessionUser(db, request);
    const { spaceId } = request.params as z.infer<typeof SpaceParams>;
    const { space } = managerForSpace(db,userId,spaceId);
    const parsed = z.object({userId:Id}).strict().safeParse(request.query);
    if (!parsed.success) throw badRequest('查询参数无效。');
    requireMember(db,space.team_id,parsed.data.userId);
    const subject = db.prepare('SELECT id,name FROM users WHERE id=?').get(parsed.data.userId) as {id:string;name:string}|undefined;
    if (!subject) throw notFound();
    const access = getSpaceAccess(db,parsed.data.userId,spaceId)!;
    return { resource:{kind:'space',id:spaceId}, subject:{...subject,teamRole:access.teamRole}, effective:flags(access), reasons:reasonsForSpace(db,parsed.data.userId,spaceId) };
  });

  app.get('/documents/:id/access/explain', { preValidation: validateParams(DocumentParams) }, async (request) => {
    const userId = requireSessionUser(db, request);
    const { id } = request.params as z.infer<typeof DocumentParams>;
    const { document } = managerForDocument(db,userId,id);
    const parsed = z.object({userId:Id}).strict().safeParse(request.query);
    if (!parsed.success) throw badRequest('查询参数无效。');
    requireMember(db,document.team_id,parsed.data.userId);
    const subject = db.prepare('SELECT id,name FROM users WHERE id=?').get(parsed.data.userId) as {id:string;name:string}|undefined;
    if (!subject) throw notFound();
    const access = getDocumentAccess(db,parsed.data.userId,id)!;
    return { resource:{kind:'document',id}, subject:{...subject,teamRole:access.teamRole}, effective:flags(access), reasons:reasonsForDocument(db,parsed.data.userId,id) };
  });

  app.post('/spaces/:spaceId/access/preview', { preValidation: [validateParams(SpaceParams),validateBody(SpacePreviewBody)] }, async (request) => {
    const actorId = requireSessionUser(db,request);
    const {spaceId} = request.params as z.infer<typeof SpaceParams>;
    const input = request.body as z.infer<typeof SpacePreviewBody>;
    const {space} = managerForSpace(db,actorId,spaceId);
    validateGrants(db,space.team_id,input.grants,input.visibility,false);
    const page={offset:input.offset,limit:input.limit};
    const allMembers=members(db,space.team_id);
    const totals=accessCounters();
    const output=withPreview(db,()=>{
      const before=new Map<string,{flags:Flags;impact:{read:number;edit:number};reasons:Reason[]}>();
      for(const member of allMembers){before.set(member.user_id,{flags:flags(getSpaceAccess(db,member.user_id,spaceId)!),impact:documentImpact(db,member.user_id,spaceId),reasons:reasonsForSpace(db,member.user_id,spaceId)});}
      db.prepare('UPDATE spaces SET visibility=? WHERE id=?').run(input.visibility,spaceId);
      replaceGrants(db,'space_grants','space_id',spaceId,input.grants);
      const changes:Array<Record<string,unknown>>=[];
      for(const member of allMembers){
        const prior=before.get(member.user_id)!;
        const after=flags(getSpaceAccess(db,member.user_id,spaceId)!);
        const impact=documentImpact(db,member.user_id,spaceId);
        const beforeImpact=prior.impact;
        const documentsReadGained=Math.max(0,impact.read-beforeImpact.read), documentsReadLost=Math.max(0,beforeImpact.read-impact.read);
        const documentsEditGained=Math.max(0,impact.edit-beforeImpact.edit), documentsEditLost=Math.max(0,beforeImpact.edit-impact.edit);
        if(!changed(prior.flags,after)&&!documentsReadGained&&!documentsReadLost&&!documentsEditGained&&!documentsEditLost) continue;
        totals.membersChanged++;
        if(!prior.flags.canRead&&after.canRead) totals.readGained++; if(prior.flags.canRead&&!after.canRead) totals.readLost++;
        if(!prior.flags.canEdit&&after.canEdit) totals.editGained++; if(prior.flags.canEdit&&!after.canEdit) totals.editLost++;
        totals.documentsReadGained+=documentsReadGained; totals.documentsReadLost+=documentsReadLost;
        totals.documentsEditGained+=documentsEditGained; totals.documentsEditLost+=documentsEditLost;
        const subject=db.prepare('SELECT name FROM users WHERE id=?').get(member.user_id) as {name:string};
        changes.push({userId:member.user_id,name:subject.name,before:prior.flags,after,beforeReasons:prior.reasons,afterReasons:reasonsForSpace(db,member.user_id,spaceId),documentsReadGained,documentsReadLost,documentsEditGained,documentsEditLost});
      }
      const result=paginate(changes,page);
      return {changes:result.entries,totals,hasMore:result.hasMore,nextOffset:result.nextOffset};
    });
    return output;
  });

  app.post('/documents/:id/access/preview', { preValidation: [validateParams(DocumentParams),validateBody(DocumentPreviewBody)] }, async (request) => {
    const actorId=requireSessionUser(db,request);
    const {id}=request.params as z.infer<typeof DocumentParams>;
    const input=request.body as z.infer<typeof DocumentPreviewBody>;
    const {document}=managerForDocument(db,actorId,id);
    validateGrants(db,document.team_id,input.grants,input.visibility,input.visibility === 'inherit');
    const allMembers=members(db,document.team_id),totals=accessCounters(),page={offset:input.offset,limit:input.limit};
    const result=withPreview(db,()=>{
      const before=new Map<string,{flags:Flags;reasons:Reason[]}>();
      for(const member of allMembers) before.set(member.user_id,{flags:flags(getDocumentAccess(db,member.user_id,id)!),reasons:reasonsForDocument(db,member.user_id,id)});
      db.prepare('UPDATE documents SET visibility=? WHERE id=?').run(input.visibility,id);
      replaceGrants(db,'document_grants','document_id',id,input.grants);
      const changes:Array<Record<string,unknown>>=[];
      for(const member of allMembers){
        const prior=before.get(member.user_id)!,after=flags(getDocumentAccess(db,member.user_id,id)!);
        if(!changed(prior.flags,after)) continue;
        totals.membersChanged++;
        if(!prior.flags.canRead&&after.canRead) totals.readGained++; if(prior.flags.canRead&&!after.canRead) totals.readLost++;
        if(!prior.flags.canEdit&&after.canEdit) totals.editGained++; if(prior.flags.canEdit&&!after.canEdit) totals.editLost++;
        const subject=db.prepare('SELECT name FROM users WHERE id=?').get(member.user_id) as {name:string};
        changes.push({userId:member.user_id,name:subject.name,before:prior.flags,after,beforeReasons:prior.reasons,afterReasons:reasonsForDocument(db,member.user_id,id),documentsReadGained:0,documentsReadLost:0,documentsEditGained:0,documentsEditLost:0});
      }
      const pageResult=paginate(changes,page);
      return {changes:pageResult.entries,totals,hasMore:pageResult.hasMore,nextOffset:pageResult.nextOffset};
    });
    return result;
  });
}
