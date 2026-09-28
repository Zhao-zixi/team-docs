import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommentSource, DocumentComment, TeamRole } from '../shared/types.js';
import { requireUserId } from './auth.js';
import { getDocumentAccess, getSpaceAccess } from './acl.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { isoNow } from './security.js';
import { validateBody, validateParams } from './validation.js';

const Id = z.string().uuid();
const Anchor = z.object({ paragraphIndex: z.number().int().min(0).max(1000000), startOffset: z.number().int().min(0).max(1000000), endOffset: z.number().int().min(0).max(1000000) }).strict().refine(value => value.endOffset >= value.startOffset);
const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('published'), version: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('draft'), draftId: Id, seq: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('proposal'), proposalId: Id }).strict(),
]);
const CommentBody = z.string().min(1).max(2000).refine(value => value.trim().length > 0 && !value.includes('\0'));
const MentionIds = z.array(Id).max(50).refine(ids => new Set(ids).size === ids.length, '提及对象不能重复。');
const CreateComment = z.object({ source: Source, quote: z.string().max(1000), anchor: Anchor, body: CommentBody, mentionUserIds: MentionIds.default([]) }).strict();
const Reply = z.object({ body: CommentBody, mentionUserIds: MentionIds.default([]) }).strict();
const Resolve = z.object({ resolved: z.boolean() }).strict();
const DocumentParams = z.object({ id: Id }).strict();
const ThreadParams = z.object({ threadId: Id }).strict();
const NotificationParams = z.object({ id: Id }).strict();
const Page = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

type CommentRow = {
  id: string; document_id: string; parent_id: string | null; source_kind: CommentSource['kind']; source_version: number | null;
  source_draft_id: string | null; source_seq: number | null; source_proposal_id: string | null; quote: string;
  paragraph_index: number; start_offset: number; end_offset: number; body: string; author_id: string; author_name: string;
  mention_user_ids_json: string; resolved: number; created_at: string; updated_at: string;
};
type NotificationRow = { id: string; comment_id: string; recipient_id: string; read_at: string | null; created_at: string; actor_name: string; document_id: string; document_title: string; body: string; quote: string; source_kind: CommentSource['kind']; source_version: number | null; source_draft_id: string | null; source_seq: number | null; source_proposal_id: string | null };

function actorId(db: AppContext['db'], request: FastifyRequest): string { return request.agentPrincipal?.userId ?? requireUserId(db, request); }
function isManager(role: TeamRole | undefined): boolean { return role === 'owner' || role === 'admin'; }
function getRow(db: AppContext['db'], id: string): CommentRow | undefined {
  return db.prepare(`SELECT c.*,u.name AS author_name FROM document_comments c JOIN users u ON u.id=c.author_id WHERE c.id=?`).get(id) as CommentRow | undefined;
}
function sourceFrom(row: Pick<CommentRow,'source_kind'|'source_version'|'source_draft_id'|'source_seq'|'source_proposal_id'>): CommentSource {
  if (row.source_kind === 'published' && row.source_version !== null) return { kind: 'published', version: row.source_version };
  if (row.source_kind === 'draft' && row.source_draft_id && row.source_seq !== null) return { kind: 'draft', draftId: row.source_draft_id, seq: row.source_seq };
  if (row.source_kind === 'proposal' && row.source_proposal_id) return { kind: 'proposal', proposalId: row.source_proposal_id };
  throw new Error('Invalid comment source row');
}
function canReadProposal(db: AppContext['db'], userId: string, proposalId: string, documentId: string, agent: boolean): boolean {
  const row = db.prepare('SELECT p.author_id,p.team_id,p.space_id,p.target_document_id,p.document_id,m.role FROM proposals p LEFT JOIN members m ON m.team_id=p.team_id AND m.user_id=? WHERE p.id=?').get(userId, proposalId) as {author_id:string;team_id:string;space_id:string;target_document_id:string|null;document_id:string|null;role:TeamRole|null}|undefined;
  if (!row || row.target_document_id !== documentId || (agent ? row.author_id !== userId : (!isManager(row.role ?? undefined) && row.author_id !== userId))) return false;
  if (isManager(row.role ?? undefined)) return Boolean(getDocumentAccess(db,userId,documentId)?.canManage);
  return Boolean(getDocumentAccess(db,userId,documentId)?.canRead);
}
function sourceState(db: AppContext['db'], userId: string, documentId: string, source: CommentSource, write: boolean, agent = false): { stale: boolean } {
  const access = getDocumentAccess(db, userId, documentId);
  if (!access?.canRead) throw notFound();
  if (write && !access.canEdit) throw forbidden();
  if (source.kind === 'published') {
    const revision = db.prepare('SELECT 1 FROM revisions WHERE document_id=? AND version=?').get(documentId, source.version);
    if (!revision) throw notFound();
    return { stale: source.version !== access.version };
  }
  if (source.kind === 'draft') {
    if (!access.canEdit) throw notFound();
    const draft = db.prepare('SELECT doc_id,state,seq FROM document_drafts WHERE id=?').get(source.draftId) as {doc_id:string;state:'editing'|'reviewing';seq:number}|undefined;
    if (!draft || draft.doc_id !== documentId || source.seq > draft.seq) throw notFound();
    if (write && draft.state !== 'editing') throw forbidden('送审后的草稿已冻结，请在提案上继续讨论。');
    return { stale: draft.seq !== source.seq || draft.state !== 'editing' };
  }
  if (!canReadProposal(db, userId, source.proposalId, documentId, agent)) throw notFound();
  const proposal = db.prepare('SELECT status,base_version FROM proposals WHERE id=?').get(source.proposalId) as {status:string;base_version:number|null}|undefined;
  if (!proposal) throw notFound();
  if (write && proposal.status !== 'pending') throw forbidden('仅待审阅提案可添加评论。');
  return { stale: proposal.status !== 'pending' || proposal.base_version !== access.version };
}
function sourceColumns(source: CommentSource) {
  return { kind: source.kind, version: source.kind === 'published' ? source.version : null,
    draftId: source.kind === 'draft' ? source.draftId : null, seq: source.kind === 'draft' ? source.seq : null,
    proposalId: source.kind === 'proposal' ? source.proposalId : null };
}
function toComment(db: AppContext['db'], viewerId: string, row: CommentRow, children?: DocumentComment[], agent = false): DocumentComment {
  const source = sourceFrom(row);
  return { id:row.id,documentId:row.document_id,parentId:row.parent_id,source,quote:row.quote,
    anchor:{paragraphIndex:row.paragraph_index,startOffset:row.start_offset,endOffset:row.end_offset},body:row.body,
    authorId:row.author_id,authorName:row.author_name,mentionUserIds:JSON.parse(row.mention_user_ids_json) as string[],
    resolved:row.resolved===1,stale:sourceState(db,viewerId,row.document_id,source,false,agent).stale,
    createdAt:row.created_at,updatedAt:row.updated_at,...(children ? { replies:children } : {}) };
}
function requireCommentAccess(db: AppContext['db'], userId: string, row: CommentRow, write: boolean, agent = false): void {
  sourceState(db,userId,row.document_id,sourceFrom(row),write,agent);
}
function validateMentions(db: AppContext['db'], actor: string, documentId: string, source: CommentSource, ids: string[]): void {
  for (const id of ids) {
    const member = db.prepare('SELECT 1 FROM spaces s JOIN members m ON m.team_id=s.team_id WHERE s.id=(SELECT space_id FROM documents WHERE id=?) AND m.user_id=?').get(documentId,id);
    if (!member) throw badRequest('提及对象必须是当前团队成员且当前有权访问此内容。');
    try { sourceState(db,id,documentId,source,false); } catch { throw badRequest('提及对象必须是当前团队成员且当前有权访问此内容。'); }
  }
  void actor;
}
function insertComment(db: AppContext['db'], input: { documentId:string;parentId:string|null;source:CommentSource;quote:string;paragraphIndex:number;startOffset:number;endOffset:number;body:string;authorId:string;mentionUserIds:string[];now:string }): string {
  const source=sourceColumns(input.source); const id=randomUUID();
  db.prepare(`INSERT INTO document_comments(id,document_id,parent_id,source_kind,source_version,source_draft_id,source_seq,source_proposal_id,quote,paragraph_index,start_offset,end_offset,body,author_id,mention_user_ids_json,resolved,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(id,input.documentId,input.parentId,source.kind,source.version,source.draftId,source.seq,source.proposalId,input.quote,input.paragraphIndex,input.startOffset,input.endOffset,input.body,input.authorId,JSON.stringify(input.mentionUserIds),input.now,input.now);
  for (const recipient of input.mentionUserIds) if (recipient !== input.authorId) db.prepare('INSERT OR IGNORE INTO comment_notifications(id,comment_id,recipient_id,created_at) VALUES(?,?,?,?)').run(randomUUID(),id,recipient,input.now);
  return id;
}
function hydrateThreads(db: AppContext['db'], userId: string, rows: CommentRow[], agent = false): DocumentComment[] {
  return rows.filter(row => { try { requireCommentAccess(db,userId,row,false,agent); return true; } catch { return false; } }).map(row => {
    const replies=db.prepare('SELECT c.*,u.name AS author_name FROM document_comments c JOIN users u ON u.id=c.author_id WHERE c.parent_id=? ORDER BY c.created_at,c.id').all(row.id) as CommentRow[];
    const readable=replies.filter(reply => { try { requireCommentAccess(db,userId,reply,false,agent); return true; } catch { return false; } });
    return toComment(db,userId,row,readable.map(reply=>toComment(db,userId,reply,undefined,agent)),agent);
  });
}

export function registerCommentRoutes(app: FastifyInstance, { db }: AppContext): void {
  app.get('/documents/:id/comments',{config:{agentAccess:{scope:'read',operation:'comment.read',documentParam:'id',allowSpaceBound:true}},preValidation:validateParams(DocumentParams)},async request=>{
    const user=actorId(db,request);const {id}=request.params as z.infer<typeof DocumentParams>;
    if(!getDocumentAccess(db,user,id)?.canRead)throw notFound();
    const parsed=Page.safeParse(request.query);if(!parsed.success)throw badRequest('分页参数无效。');
    const rows=db.prepare('SELECT c.*,u.name AS author_name FROM document_comments c JOIN users u ON u.id=c.author_id WHERE c.document_id=? AND c.parent_id IS NULL ORDER BY c.created_at,c.id LIMIT ? OFFSET ?').all(id,parsed.data.limit+1,parsed.data.offset) as CommentRow[];
    const hasMore=rows.length>parsed.data.limit;const page=rows.slice(0,parsed.data.limit);
    return {comments:hydrateThreads(db,user,page,Boolean(request.agentPrincipal)),hasMore,nextOffset:hasMore?parsed.data.offset+parsed.data.limit:null};
  });
  app.post('/documents/:id/comments',{config:{agentAccess:{scope:'write',operation:'comment.write',documentParam:'id',allowSpaceBound:true}},preValidation:[validateParams(DocumentParams),validateBody(CreateComment)]},async(request,reply)=>{
    const user=actorId(db,request);const {id}=request.params as z.infer<typeof DocumentParams>;const input=request.body as z.infer<typeof CreateComment>;
    sourceState(db,user,id,input.source,true,Boolean(request.agentPrincipal));validateMentions(db,user,id,input.source,input.mentionUserIds);
    const now=isoNow();let commentId='';transaction(db,()=>{commentId=insertComment(db,{documentId:id,parentId:null,source:input.source,quote:input.quote,paragraphIndex:input.anchor.paragraphIndex,startOffset:input.anchor.startOffset,endOffset:input.anchor.endOffset,body:input.body,authorId:user,mentionUserIds:input.mentionUserIds,now});});
    return reply.code(201).send({comment:toComment(db,user,getRow(db,commentId)!,undefined,Boolean(request.agentPrincipal))});
  });
  app.post('/comments/:threadId/replies',{config:{agentAccess:{scope:'write',operation:'comment.write',commentParam:'threadId',allowSpaceBound:true}},preValidation:[validateParams(ThreadParams),validateBody(Reply)]},async(request,reply)=>{
    const user=actorId(db,request);const {threadId}=request.params as z.infer<typeof ThreadParams>;const root=getRow(db,threadId);
    if(!root||root.parent_id!==null)throw notFound();requireCommentAccess(db,user,root,true,Boolean(request.agentPrincipal));if(root.resolved)throw forbidden('已解决的讨论不能继续回复。');
    const source=sourceFrom(root);const input=request.body as z.infer<typeof Reply>;validateMentions(db,user,root.document_id,source,input.mentionUserIds);
    const now=isoNow();let id='';transaction(db,()=>{id=insertComment(db,{documentId:root.document_id,parentId:root.id,source,quote:root.quote,paragraphIndex:root.paragraph_index,startOffset:root.start_offset,endOffset:root.end_offset,body:input.body,authorId:user,mentionUserIds:input.mentionUserIds,now});});
    return reply.code(201).send({comment:toComment(db,user,getRow(db,id)!,undefined,Boolean(request.agentPrincipal))});
  });
  app.patch('/comments/:threadId',{config:{agentAccess:{scope:'write',operation:'comment.write',commentParam:'threadId',allowSpaceBound:true}},preValidation:[validateParams(ThreadParams),validateBody(Resolve)]},async request=>{
    const user=actorId(db,request);const {threadId}=request.params as z.infer<typeof ThreadParams>;const root=getRow(db,threadId);if(!root||root.parent_id!==null)throw notFound();if(request.agentPrincipal)requireCommentAccess(db,user,root,true,true);
    const access=getDocumentAccess(db,user,root.document_id);if(!access?.canRead)throw notFound();if(!access.canManage&&!(access.canEdit&&root.author_id===user))throw forbidden();
    const {resolved}=request.body as z.infer<typeof Resolve>;db.prepare('UPDATE document_comments SET resolved=?,updated_at=? WHERE id=? AND parent_id IS NULL').run(resolved?1:0,isoNow(),root.id);
    return {comment:toComment(db,user,getRow(db,root.id)!)};
  });
  app.get('/notifications',{preValidation:[],},async request=>{
    const user=actorId(db,request);const parsed=Page.safeParse(request.query);if(!parsed.success)throw badRequest('分页参数无效。');
    const rows=db.prepare(`SELECT n.id,n.comment_id,n.recipient_id,n.read_at,n.created_at,c.document_id,c.body,c.quote,c.source_kind,c.source_version,c.source_draft_id,c.source_seq,c.source_proposal_id,d.title AS document_title,u.name AS actor_name
      FROM comment_notifications n JOIN document_comments c ON c.id=n.comment_id JOIN documents d ON d.id=c.document_id JOIN users u ON u.id=c.author_id
      WHERE n.recipient_id=? ORDER BY n.created_at DESC,n.id LIMIT ? OFFSET ?`).all(user,parsed.data.limit+1,parsed.data.offset) as NotificationRow[];
    const valid=rows.filter(row=>{try{sourceState(db,user,row.document_id,sourceFrom(row),false);return Boolean(getDocumentAccess(db,user,row.document_id)?.canRead);}catch{return false;}});
    const page=valid.slice(0,parsed.data.limit);const hasMore=rows.length>parsed.data.limit;
    return {notifications:page.map(row=>({id:row.id,commentId:row.comment_id,documentId:row.document_id,documentTitle:row.document_title,body:row.body,quote:row.quote,actorName:row.actor_name,source:sourceFrom(row),createdAt:row.created_at,readAt:row.read_at})),hasMore,nextOffset:hasMore?parsed.data.offset+parsed.data.limit:null};
  });
  app.post('/notifications/:id/read',{preValidation:validateParams(NotificationParams)},async request=>{
    const user=actorId(db,request);const {id}=request.params as z.infer<typeof NotificationParams>;
    const row=db.prepare(`SELECT n.id,c.document_id,c.source_kind,c.source_version,c.source_draft_id,c.source_seq,c.source_proposal_id FROM comment_notifications n JOIN document_comments c ON c.id=n.comment_id WHERE n.id=? AND n.recipient_id=?`).get(id,user) as Pick<NotificationRow,'id'|'document_id'|'source_kind'|'source_version'|'source_draft_id'|'source_seq'|'source_proposal_id'>|undefined;
    if(!row)throw notFound();sourceState(db,user,row.document_id,sourceFrom(row),false);db.prepare('UPDATE comment_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?').run(isoNow(),id,user);return {ok:true};
  });
}
