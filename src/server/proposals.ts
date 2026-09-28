import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Proposal, ProposalSummary, TeamRole } from '../shared/types.js';
import { requireUserId } from './auth.js';
import { getDocumentAccess, getSpaceAccess } from './acl.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { isoNow } from './security.js';
import { validateBody, validateParams } from './validation.js';

const Id = z.string().uuid();
const Title = z.string().min(1).max(200).refine((v) => v.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(v));
const Body = z.string().max(500 * 1024);
const Grant = z.object({userId:Id,role:z.enum(['viewer','editor'])}).strict();
const Create = z.object({kind:z.literal('create'),title:Title,body:Body,visibility:z.enum(['inherit','restricted']).default('inherit'),grants:z.array(Grant).max(500).default([])}).strict();
const Update = z.object({kind:z.literal('update'),baseVersion:z.number().int().positive(),title:Title,body:Body}).strict();
const Restore = z.object({kind:z.literal('restore'),baseVersion:z.number().int().positive(),revisionId:Id}).strict();
const Delete = z.object({kind:z.literal('delete'),baseVersion:z.number().int().positive()}).strict();
const DocumentProposal = z.discriminatedUnion('kind',[Update,Restore,Delete]);
const SpaceParams = z.object({spaceId:Id}).strict();
const DocumentParams = z.object({id:Id}).strict();
const TeamParams = z.object({teamId:Id}).strict();
const ProposalParams = z.object({id:Id}).strict();
const Decision = z.object({decision:z.enum(['approve','reject']),note:z.string().max(2000).optional()}).strict();
const ListQuery = z.object({status:z.enum(['pending','approved','rejected','withdrawn','conflicted']).optional(),mine:z.coerce.boolean().optional().default(false),offset:z.coerce.number().int().min(0).max(10000000).default(0),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict();

type ProposalRow = {id:string;team_id:string;space_id:string;document_id:string|null;target_document_id:string|null;kind:Proposal['kind'];author_id:string;author_name:string;base_version:number|null;title:string;body:string;visibility:'inherit'|'restricted';grants_json:string;source_draft_id:string|null;revision_id:string|null;status:Proposal['status'];reviewer_id:string|null;decision_note:string|null;created_at:string;decided_at:string|null};
function audit(db:AppContext['db'],teamId:string,actorId:string,action:string,targetId:string,details:Record<string,unknown>={}):void{
 db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json) VALUES(?,?,?,'proposal.'||?,'proposal',?,?,?)`).run(randomUUID(),teamId,actorId,action,targetId,isoNow(),JSON.stringify(details));
}
function sessionActor(db:AppContext['db'],request:FastifyRequest):string{
 if(request.agentPrincipal) throw forbidden('此操作仅支持浏览器会话。');
 return requireUserId(db,request);
}
function isManager(role:string):boolean{return role==='owner'||role==='admin';}
function toSummary(row:ProposalRow):ProposalSummary{return {id:row.id,teamId:row.team_id,spaceId:row.space_id,documentId:row.target_document_id??row.document_id,kind:row.kind,authorId:row.author_id,authorName:row.author_name,baseVersion:row.base_version,title:row.title,status:row.status,reviewerId:row.reviewer_id,decisionNote:row.decision_note,createdAt:row.created_at,decidedAt:row.decided_at};}
function toProposal(row:ProposalRow):Proposal{return {...toSummary(row),body:row.body,sourceDraftId:row.source_draft_id,visibility:row.visibility,grants:JSON.parse(row.grants_json) as Proposal['grants'],revisionId:row.revision_id};}
function getProposal(db:AppContext['db'],id:string):ProposalRow|undefined{return db.prepare(`SELECT p.*,u.name AS author_name FROM proposals p JOIN users u ON u.id=p.author_id WHERE p.id=?`).get(id) as ProposalRow|undefined;}
function requireCurrentSpaceAccess(db:AppContext['db'],userId:string,spaceId:string,canEdit:boolean){const access=getSpaceAccess(db,userId,spaceId);if(!access?.canRead)throw notFound();if(canEdit&&!access.canEdit)throw forbidden();return access;}
function assertGrantMembers(db:AppContext['db'],teamId:string,grants:Array<{userId:string;role:'viewer'|'editor'}>):void{if(!grants.length)return;const ids=grants.map(x=>x.userId);const found=db.prepare(`SELECT user_id FROM members WHERE team_id=? AND user_id IN (${ids.map(()=>'?').join(',')})`).all(teamId,...ids) as Array<{user_id:string}>;if(found.length!==ids.length)throw badRequest('授权对象必须是当前团队成员。');}
function replaceDocumentGrants(db:AppContext['db'],documentId:string,grants:Array<{userId:string;role:'viewer'|'editor'}>):void{db.prepare('DELETE FROM document_grants WHERE document_id=?').run(documentId);for(const g of grants)db.prepare('INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,?)').run(documentId,g.userId,g.role);}
function managerOnProposal(db:AppContext['db'],userId:string,row:ProposalRow):void{
 const member=db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(row.team_id,userId) as {role:TeamRole}|undefined;
 if(!member)throw notFound();if(!isManager(member.role))throw forbidden();if(row.document_id&&!getDocumentAccess(db,userId,row.document_id)?.canManage)throw notFound();if(!row.document_id&&!getSpaceAccess(db,userId,row.space_id)?.canManage)throw notFound();
}
function insertRevision(db:AppContext['db'],documentId:string,version:number,title:string,body:string,userId:string,authorName:string,now:string):void{
 db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),documentId,version,title,body,now,userId,authorName);
}

export function registerProposalRoutes(app:FastifyInstance,{db}:AppContext):void{
 app.post('/spaces/:spaceId/proposals',{config:{agentAccess:{scope:'write',operation:'document.write',spaceParam:'spaceId',allowSpaceBound:true}},preValidation:[validateParams(SpaceParams),validateBody(Create)]},async(request,reply)=>{
  const principal=request.agentPrincipal;const authorId=principal?.userId??requireUserId(db,request);const {spaceId}=request.params as z.infer<typeof SpaceParams>;const input=request.body as z.infer<typeof Create>;
  const space=db.prepare('SELECT id,team_id,require_review FROM spaces WHERE id=?').get(spaceId) as {id:string;team_id:string;require_review:number}|undefined;
  const access=getSpaceAccess(db,authorId,spaceId);if(!space||!access?.canRead)throw notFound();if(!access.canEdit)throw forbidden();
  if(input.visibility==='restricted'&&!input.grants.length){} else if(input.visibility==='inherit'&&input.grants.length)throw badRequest('inherit 文档不能包含单独授权。');
  assertGrantMembers(db,space.team_id,input.grants);if(principal&&input.visibility==='restricted'&&principal.scope!=='manage')throw forbidden();
  const user=db.prepare('SELECT name FROM users WHERE id=?').get(authorId) as {name:string};const id=randomUUID(),now=isoNow();
  transaction(db,()=>{db.prepare(`INSERT INTO proposals(id,team_id,space_id,kind,author_id,title,body,visibility,grants_json,status,created_at) VALUES(?,?,?,'create',?,?,?,?,?,'pending',?)`).run(id,space.team_id,spaceId,authorId,input.title.trim(),input.body,input.visibility,JSON.stringify(input.grants),now);audit(db,space.team_id,authorId,'submit',id,{kind:'create'});});
  return reply.code(201).send({proposal:toProposal(getProposal(db,id)!)});
 });
 app.post('/documents/:id/proposals',{config:{agentAccess:{scope:'write',operation:'document.write',documentParam:'id',allowSpaceBound:true}},preValidation:[validateParams(DocumentParams),validateBody(DocumentProposal)]},async(request,reply)=>{
  const principal=request.agentPrincipal;const authorId=principal?.userId??requireUserId(db,request);const {id:documentId}=request.params as z.infer<typeof DocumentParams>;const input=request.body as z.infer<typeof DocumentProposal>;
  const doc=db.prepare('SELECT d.id,d.space_id,d.version,d.title,d.body,s.team_id FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.id=?').get(documentId) as {id:string;space_id:string;version:number;title:string;body:string;team_id:string}|undefined;
  const access=getDocumentAccess(db,authorId,documentId);if(!doc||!access?.canRead)throw notFound();if(input.baseVersion!==doc.version)throw conflict('文档版本已变化，请刷新后重试。');
  const actionManage=input.kind==='restore'||input.kind==='delete';if(actionManage&&!access.canManage)throw forbidden();if(!actionManage&&!access.canEdit)throw forbidden();
  if(principal&&actionManage&&principal.scope!=='manage')throw forbidden();
  let title=doc.title,body=doc.body,revisionId:string|null=null;
  if(input.kind==='update'){title=input.title.trim();body=input.body;}
  if(input.kind==='restore'){const revision=db.prepare('SELECT title,body FROM revisions WHERE id=? AND document_id=?').get(input.revisionId,documentId) as {title:string;body:string}|undefined;if(!revision)throw notFound();title=revision.title;body=revision.body;revisionId=input.revisionId;}
  const id=randomUUID(),now=isoNow();transaction(db,()=>{db.prepare(`INSERT INTO proposals(id,team_id,space_id,document_id,target_document_id,kind,author_id,base_version,title,body,revision_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(id,doc.team_id,doc.space_id,documentId,documentId,input.kind,authorId,input.baseVersion,title,body,revisionId,now);audit(db,doc.team_id,authorId,'submit',id,{kind:input.kind,documentId});});
  return reply.code(201).send({proposal:toProposal(getProposal(db,id)!)});
 });
 app.get('/teams/:teamId/proposals',{config:{agentAccess:{scope:'read',operation:'proposal.read',teamParam:'teamId',allowSpaceBound:true}},preValidation:validateParams(TeamParams)},async(request)=>{
  const {teamId}=request.params as z.infer<typeof TeamParams>;const parsed=ListQuery.safeParse(request.query);if(!parsed.success)throw badRequest('查询参数无效。');const {status,offset,limit,mine}=parsed.data;
  const principal=request.agentPrincipal;
  if(principal){
   const rows=db.prepare(`SELECT p.*,u.name AS author_name FROM proposals p JOIN users u ON u.id=p.author_id WHERE p.team_id=? AND p.author_id=? AND (? IS NULL OR p.status=?) AND (? IS NULL OR p.space_id=?) ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?`).all(teamId,principal.userId,status??null,status??null,principal.spaceId,principal.spaceId,limit+1,offset) as ProposalRow[];
   const visible=rows.slice(0,limit).map(toSummary);return {proposals:visible,hasMore:rows.length>limit,nextOffset:rows.length>limit?offset+limit:null};
  }
  const actor=sessionActor(db,request);const role=db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId,actor) as {role:TeamRole}|undefined;if(!role)throw notFound();if(!isManager(role.role)&&!mine)throw forbidden();
  const rows=db.prepare(`SELECT p.*,u.name AS author_name FROM proposals p JOIN users u ON u.id=p.author_id WHERE p.team_id=? AND (? IS NULL OR p.status=?) AND (?=0 OR p.author_id=?) ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?`).all(teamId,status??null,status??null,mine?1:0,actor,limit+1,offset) as ProposalRow[];
  const visible=rows.slice(0,limit).map(toSummary);return {proposals:visible,hasMore:rows.length>limit,nextOffset:rows.length>limit?offset+limit:null};
 }); app.get('/proposals/:id',{config:{agentAccess:{scope:'read',operation:'proposal.read',proposalParam:'id',allowSpaceBound:true}},preValidation:validateParams(ProposalParams)},async(request)=>{
  const userId=request.agentPrincipal?.userId??sessionActor(db,request);const {id}=request.params as z.infer<typeof ProposalParams>;const row=getProposal(db,id);if(!row)throw notFound();
  const isAuthor=row.author_id===userId;const manager=isManager((db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(row.team_id,userId) as {role:TeamRole}|undefined)?.role??'viewer');
  if(!isAuthor&&!manager)throw notFound();if(manager)managerOnProposal(db,userId,row);else {if(!db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(row.team_id,userId))throw notFound();if(row.document_id&&!getDocumentAccess(db,userId,row.document_id)?.canRead)throw notFound();if(!row.document_id&&!getSpaceAccess(db,userId,row.space_id)?.canRead)throw notFound();}return {proposal:toProposal(row)};
 });
 app.post('/proposals/:id/withdraw',{preValidation:validateParams(ProposalParams)},async(request)=>{
  const userId=sessionActor(db,request);const {id}=request.params as z.infer<typeof ProposalParams>;const row=getProposal(db,id);if(!row||row.author_id!==userId)throw notFound();if(row.status!=='pending')throw conflict();
  transaction(db,()=>{const result=db.prepare("UPDATE proposals SET status='withdrawn',decided_at=? WHERE id=? AND author_id=? AND status='pending'").run(isoNow(),id,userId);if(result.changes!==1)throw conflict();audit(db,row.team_id,userId,'withdraw',id,{kind:row.kind});});return {ok:true};
 });
 app.post('/proposals/:id/decision',{preValidation:[validateParams(ProposalParams),validateBody(Decision)]},async(request)=>{
  const reviewer=sessionActor(db,request);const {id}=request.params as z.infer<typeof ProposalParams>;const input=request.body as z.infer<typeof Decision>;const row=getProposal(db,id);if(!row)throw notFound();managerOnProposal(db,reviewer,row);if(row.author_id===reviewer)throw forbidden('提交者不能审批自己的提案。');if(row.status!=='pending')throw conflict();
  const user=db.prepare('SELECT name FROM users WHERE id=?').get(reviewer) as {name:string};const now=isoNow();let conflicted=false;
  transaction(db,()=>{
   const fresh=getProposal(db,id);if(!fresh||fresh.status!=='pending')throw conflict();managerOnProposal(db,reviewer,fresh);if(fresh.author_id===reviewer)throw forbidden('提交者不能审批自己的提案。');
   const policy=db.prepare('SELECT require_review FROM spaces WHERE id=?').get(fresh.space_id) as {require_review:number}|undefined;
   if(!policy||policy.require_review!==1){db.prepare("UPDATE proposals SET status='conflicted',reviewer_id=?,decision_note='review_policy_disabled',decided_at=? WHERE id=? AND status='pending'").run(reviewer,now,id);conflicted=true;return;}
   if(input.decision==='reject'){db.prepare("UPDATE proposals SET status='rejected',reviewer_id=?,decision_note=?,decided_at=? WHERE id=? AND status='pending'").run(reviewer,input.note??null,now,id);audit(db,fresh.team_id,reviewer,'reject',id,{kind:fresh.kind});return;}
   const authorAccess=fresh.kind==='create'?getSpaceAccess(db,fresh.author_id,fresh.space_id):fresh.target_document_id?getDocumentAccess(db,fresh.author_id,fresh.target_document_id):undefined;
   const authorAllowed=Boolean(authorAccess&&(fresh.kind==='restore'||fresh.kind==='delete'?authorAccess.canManage:authorAccess.canEdit));
   if(!authorAllowed){db.prepare("UPDATE proposals SET status='conflicted',reviewer_id=?,decision_note='author_access_changed',decided_at=? WHERE id=? AND status='pending'").run(reviewer,now,id);conflicted=true;return;}
   if(fresh.kind==='create') assertGrantMembers(db,fresh.team_id,JSON.parse(fresh.grants_json) as Array<{userId:string;role:'viewer'|'editor'}>);
   if(fresh.kind!=='create'){
    const current=db.prepare('SELECT version FROM documents WHERE id=? AND space_id=?').get(fresh.target_document_id,fresh.space_id) as {version:number}|undefined;
    if(!current||current.version!==fresh.base_version){db.prepare("UPDATE proposals SET status='conflicted',reviewer_id=?,decision_note='base_version_changed',decided_at=? WHERE id=? AND status='pending'").run(reviewer,now,id);audit(db,fresh.team_id,reviewer,'conflict',id,{kind:fresh.kind});conflicted=true;return;}
   }
   if(fresh.kind==='create'){
    const documentId=randomUUID();db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)`).run(documentId,fresh.space_id,fresh.title,fresh.body,fresh.visibility,fresh.author_id,fresh.created_at,reviewer,now);
    replaceDocumentGrants(db,documentId,JSON.parse(fresh.grants_json) as Array<{userId:string;role:'viewer'|'editor'}>);insertRevision(db,documentId,1,fresh.title,fresh.body,reviewer,user.name,now);db.prepare('UPDATE proposals SET document_id=? WHERE id=?').run(documentId,id);
   } else if(fresh.kind==='delete'){
    audit(db,fresh.team_id,reviewer,'document.delete.approved',fresh.target_document_id!,{proposalId:id,title:fresh.title});db.prepare('DELETE FROM documents WHERE id=?').run(fresh.target_document_id);
   } else {
    const current=db.prepare('SELECT version FROM documents WHERE id=?').get(fresh.target_document_id) as {version:number};const version=current.version+1;
    const changed=db.prepare('UPDATE documents SET title=?,body=?,version=?,updated_by=?,updated_at=? WHERE id=? AND version=?').run(fresh.title,fresh.body,version,reviewer,now,fresh.target_document_id,fresh.base_version);
    if(changed.changes!==1){db.prepare("UPDATE proposals SET status='conflicted',reviewer_id=?,decision_note='base_version_changed',decided_at=? WHERE id=? AND status='pending'").run(reviewer,now,id);conflicted=true;return;}
    insertRevision(db,fresh.target_document_id!,version,fresh.title,fresh.body,reviewer,user.name,now);
   }
   db.prepare("UPDATE proposals SET status='approved',reviewer_id=?,decision_note=?,decided_at=? WHERE id=? AND status='pending'").run(reviewer,input.note??null,now,id);audit(db,fresh.team_id,reviewer,'approve',id,{kind:fresh.kind,documentId:fresh.target_document_id});
  });
  if(conflicted)throw conflict('提案基于的文档版本已变化；提案已标记为冲突，请重新提交。');return {proposal:toSummary(getProposal(db,id)!)};
 });
}
