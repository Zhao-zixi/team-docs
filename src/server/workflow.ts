import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DocumentWorkflow, TeamReminderSettings } from '../shared/types.js';
import { getDocumentAccess } from './acl.js';
import { requireUserId } from './auth.js';
import type { AppContext } from './context.js';
import { transaction } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { sendConfiguredMail } from './mailer.js';
import { isoNow } from './security.js';
import { validateBody, validateParams } from './validation.js';

const Id = z.string().uuid();
const DocumentParams = z.object({ id: Id }).strict();
const TeamParams = z.object({ teamId: Id }).strict();
const WorkflowBody = z.object({
  responsibleUserId: Id.nullable(),
  reviewAt: z.string().datetime({ offset: true }).nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  metadataVersion: z.number().int().nonnegative(),
}).strict();
const ReminderBody = z.object({ enabled: z.boolean(), senderUserId: Id.nullable() }).strict();

function sessionUser(db: AppContext['db'], request: FastifyRequest): string {
  if (request.agentPrincipal) throw forbidden('此操作仅支持浏览器会话。');
  return requireUserId(db, request);
}
function audit(db: AppContext['db'], teamId: string, actorId: string, action: string, targetType: string, targetId: string, details: unknown): void {
  db.prepare(`INSERT INTO audit_events(id,team_id,actor_id,action,target_type,target_id,created_at,details_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), teamId, actorId, action, targetType, targetId, isoNow(), JSON.stringify(details));
}
function workflowStatus(db: AppContext['db'], documentId: string): DocumentWorkflow['status'] {
  if (db.prepare("SELECT 1 FROM document_drafts WHERE doc_id=? AND state='editing'").get(documentId)) return 'draft';
  if (db.prepare("SELECT 1 FROM proposals WHERE target_document_id=? AND status='pending' LIMIT 1").get(documentId)) return 'in_review';
  return 'published';
}
function workflowDto(db: AppContext['db'], documentId: string): DocumentWorkflow {
  const row = db.prepare(`SELECT w.responsible_user_id,u.name AS responsible_name,w.review_at,w.last_reviewed_at,w.due_at,w.metadata_version
    FROM documents d LEFT JOIN document_workflow w ON w.document_id=d.id LEFT JOIN users u ON u.id=w.responsible_user_id WHERE d.id=?`).get(documentId) as {
      responsible_user_id: string | null; responsible_name: string | null; review_at: string | null; last_reviewed_at: string | null; due_at: string | null; metadata_version: number | null;
    } | undefined;
  if (!row) throw notFound();
  return { documentId, responsibleUserId: row.responsible_user_id, responsibleName: row.responsible_name,
    reviewAt: row.review_at, lastReviewedAt: row.last_reviewed_at, dueAt: row.due_at, metadataVersion: row.metadata_version ?? 0, status: workflowStatus(db, documentId) };
}
function requireManager(db: AppContext['db'], teamId: string, userId: string): void {
  const member = db.prepare('SELECT role FROM members WHERE team_id=? AND user_id=?').get(teamId, userId) as { role: string } | undefined;
  if (!member) throw notFound();
  if (member.role !== 'owner' && member.role !== 'admin') throw forbidden();
}

export async function processReminderOutbox(context: AppContext, now = new Date()): Promise<void> {
  const { db, config } = context;
  const sender = context.mailSender ?? sendConfiguredMail;
  const nowIso = now.toISOString();
  transaction(db, () => {
    const due = db.prepare(`SELECT d.id AS document_id,s.team_id,w.responsible_user_id,w.review_at,w.due_at
      FROM documents d JOIN spaces s ON s.id=d.space_id JOIN document_workflow w ON w.document_id=d.id
      JOIN team_reminders r ON r.team_id=s.team_id AND r.enabled=1
      WHERE w.responsible_user_id IS NOT NULL AND ((w.review_at IS NOT NULL AND w.review_at<=?) OR (w.due_at IS NOT NULL AND w.due_at<=?))`).all(nowIso, nowIso) as Array<{
        document_id: string; team_id: string; responsible_user_id: string; review_at: string | null; due_at: string | null;
      }>;
    const insert = db.prepare(`INSERT OR IGNORE INTO reminder_outbox(id,team_id,document_id,kind,due_at,recipient_id,status,attempts,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,?,'pending',0,?,?)`);
    for (const item of due) {
      if (item.review_at && item.review_at <= nowIso) insert.run(randomUUID(), item.team_id, item.document_id, 'review', item.review_at, item.responsible_user_id, nowIso, nowIso);
      if (item.due_at && item.due_at <= nowIso) insert.run(randomUUID(), item.team_id, item.document_id, 'due', item.due_at, item.responsible_user_id, nowIso, nowIso);
    }
  });

  const tasks = db.prepare(`SELECT id,team_id,document_id,kind,due_at,recipient_id,attempts FROM reminder_outbox
    WHERE (status='pending' AND next_attempt_at<=?) OR (status='sending' AND claimed_at<=?) ORDER BY next_attempt_at,created_at LIMIT 10`)
    .all(nowIso, new Date(now.getTime() - 5 * 60_000).toISOString()) as Array<{
      id: string; team_id: string; document_id: string; kind: 'review' | 'due'; due_at: string; recipient_id: string; attempts: number;
    }>;
  for (const task of tasks) {
    const claimed = transaction(db, () => db.prepare(`UPDATE reminder_outbox SET status='sending',attempts=attempts+1,claimed_at=?
      WHERE id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND claimed_at<=?))`)
      .run(nowIso, task.id, nowIso, new Date(now.getTime() - 5 * 60_000).toISOString()).changes === 1);
    if (!claimed) continue;
    const live = db.prepare(`SELECT d.title,d.space_id,s.team_id,w.responsible_user_id,w.review_at,w.due_at,
        r.enabled,r.sender_user_id,u.email AS recipient_email,
        (SELECT role FROM members WHERE team_id=s.team_id AND user_id=r.sender_user_id) AS sender_role,
        (SELECT 1 FROM mail_settings WHERE user_id=r.sender_user_id) AS sender_configured
      FROM documents d JOIN spaces s ON s.id=d.space_id LEFT JOIN document_workflow w ON w.document_id=d.id
      LEFT JOIN team_reminders r ON r.team_id=s.team_id JOIN users u ON u.id=? WHERE d.id=?`)
      .get(task.recipient_id, task.document_id) as {
        title:string;space_id:string;team_id:string;responsible_user_id:string|null;review_at:string|null;due_at:string|null;
        enabled:number|null;sender_user_id:string|null;recipient_email:string;sender_role:string|null;sender_configured:number|null;
      }|undefined;
    const activeDate = task.kind === 'review' ? live?.review_at : live?.due_at;
    const allowed = live && live.team_id === task.team_id && live.enabled === 1 && live.sender_user_id && live.sender_configured
      && (live.sender_role === 'owner' || live.sender_role === 'admin') && live.responsible_user_id === task.recipient_id
      && activeDate === task.due_at && Boolean(getDocumentAccess(db, task.recipient_id, task.document_id)?.canEdit);
    if (!allowed) {
      db.prepare("UPDATE reminder_outbox SET status='cancelled',claimed_at=NULL,last_error='eligibility_changed' WHERE id=? AND status='sending'").run(task.id);
      continue;
    }
    try {
      await sender(db, config.dataDir, live.sender_user_id!, {
        to: live.recipient_email,
        subject: task.kind === 'review' ? `复核提醒：${live.title}` : `到期提醒：${live.title}`,
        text: task.kind === 'review'
          ? `请复核文档「${live.title}」。打开 TeamShelf 查看当前有权访问的内容。`
          : `文档「${live.title}」已到期。打开 TeamShelf 查看当前有权访问的内容。`,
      });
      db.prepare("UPDATE reminder_outbox SET status='sent',sent_at=?,claimed_at=NULL,last_error=NULL WHERE id=? AND status='sending'").run(nowIso, task.id);
    } catch {
      const attempts = task.attempts + 1;
      const exhausted = attempts >= 5;
      const delayMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
      db.prepare("UPDATE reminder_outbox SET status=?,claimed_at=NULL,last_error='delivery_failed',next_attempt_at=? WHERE id=? AND status='sending'")
        .run(exhausted ? 'failed' : 'pending', new Date(now.getTime() + delayMinutes * 60_000).toISOString(), task.id);
    }
  }
}

export function registerWorkflowRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;
  app.get('/documents/:id/workflow', { config:{agentAccess:{scope:'read',operation:'document.read',documentParam:'id',allowSpaceBound:true}}, preValidation: validateParams(DocumentParams) }, async request => {
    const user = request.agentPrincipal?.userId ?? sessionUser(db, request);
    const { id } = request.params as z.infer<typeof DocumentParams>;
    if (!getDocumentAccess(db, user, id)?.canRead) throw notFound();
    return { workflow: workflowDto(db, id) };
  });
  app.patch('/documents/:id/workflow', { config:{agentAccess:{scope:'manage',operation:'document.manage',documentParam:'id',allowSpaceBound:true}}, preValidation: [validateParams(DocumentParams), validateBody(WorkflowBody)] }, async request => {
    const user = request.agentPrincipal?.userId ?? sessionUser(db, request);
    const { id } = request.params as z.infer<typeof DocumentParams>;
    const access = getDocumentAccess(db, user, id);
    if (!access) throw notFound();
    if (!access.canManage) throw forbidden();
    const input = request.body as z.infer<typeof WorkflowBody>;
    if (input.responsibleUserId) {
      const assigned = getDocumentAccess(db, input.responsibleUserId, id);
      if (!assigned?.canEdit) throw forbidden('负责人必须是当前有编辑权限的团队成员。');
    }
    transaction(db, () => {
      const current = db.prepare('SELECT metadata_version FROM document_workflow WHERE document_id=?').get(id) as { metadata_version: number } | undefined;
      const currentVersion = current?.metadata_version ?? 0;
      if (currentVersion !== input.metadataVersion) throw conflict('工作流信息已被其他人修改，请刷新后重试。');
      const nextVersion = currentVersion + 1;
      const now = isoNow();
      db.prepare(`INSERT INTO document_workflow(document_id,responsible_user_id,review_at,last_reviewed_at,due_at,metadata_version,updated_by,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET responsible_user_id=excluded.responsible_user_id,
        review_at=excluded.review_at,due_at=excluded.due_at,metadata_version=excluded.metadata_version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(id, input.responsibleUserId, input.reviewAt, null, input.dueAt, nextVersion, user, now);
      audit(db, access.teamId, user, 'workflow.update', 'document', id, { responsibleUserId: input.responsibleUserId, reviewAt: input.reviewAt, dueAt: input.dueAt, metadataVersion: nextVersion });
    });
    return { workflow: workflowDto(db, id) };
  });
  app.post('/documents/:id/workflow/mark-reviewed', { config:{agentAccess:{scope:'write',operation:'document.write',documentParam:'id',allowSpaceBound:true}}, preValidation: [validateParams(DocumentParams), validateBody(z.object({ metadataVersion: z.number().int().nonnegative() }).strict())] }, async request => {
    const user = request.agentPrincipal?.userId ?? sessionUser(db, request);
    const { id } = request.params as z.infer<typeof DocumentParams>;
    const access = getDocumentAccess(db, user, id);
    if (!access) throw notFound();
    const input = request.body as { metadataVersion: number };
    transaction(db, () => {
      const current = db.prepare('SELECT responsible_user_id,metadata_version FROM document_workflow WHERE document_id=?').get(id) as {responsible_user_id:string|null;metadata_version:number}|undefined;
      if ((current?.metadata_version ?? 0) !== input.metadataVersion) throw conflict('工作流信息已被其他人修改，请刷新后重试。');
      const freshAccess=getDocumentAccess(db,user,id);if(!freshAccess?.canRead)throw notFound();if(!freshAccess.canManage&&(current?.responsible_user_id!==user||!freshAccess.canEdit))throw forbidden();
      const now = isoNow();
      db.prepare(`INSERT INTO document_workflow(document_id,responsible_user_id,review_at,last_reviewed_at,due_at,metadata_version,updated_by,updated_at) VALUES(?,?,NULL,?,?,?, ?,?) ON CONFLICT(document_id) DO UPDATE SET review_at=NULL,last_reviewed_at=excluded.last_reviewed_at,metadata_version=excluded.metadata_version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(id,current?.responsible_user_id??null,now,null,input.metadataVersion+1,user,now);
      audit(db, access.teamId, user, 'workflow.reviewed', 'document', id, { metadataVersion: input.metadataVersion + 1 });
    });
    return { workflow: workflowDto(db, id) };
  });
  app.get('/teams/:teamId/reminders', { preValidation: validateParams(TeamParams) }, async request => {
    const user = sessionUser(db, request);
    const { teamId } = request.params as z.infer<typeof TeamParams>;
    requireManager(db, teamId, user);
    const row = db.prepare('SELECT enabled,sender_user_id FROM team_reminders WHERE team_id=?').get(teamId) as { enabled: number; sender_user_id: string | null } | undefined;
    return { reminders: { enabled: row?.enabled === 1, senderUserId: row?.sender_user_id ?? null } satisfies TeamReminderSettings };
  });
  app.put('/teams/:teamId/reminders', { preValidation: [validateParams(TeamParams), validateBody(ReminderBody)] }, async request => {
    const user = sessionUser(db, request);
    const { teamId } = request.params as z.infer<typeof TeamParams>;
    requireManager(db, teamId, user);
    const input = request.body as z.infer<typeof ReminderBody>;
    if (input.senderUserId !== null && input.senderUserId !== user) throw forbidden('只能选择当前账号作为发件人。');
    if (input.enabled && (!input.senderUserId || !db.prepare('SELECT 1 FROM mail_settings WHERE user_id=?').get(user))) {
      throw forbidden('启用邮件提醒前，请先配置个人发信邮箱。');
    }
    const now = isoNow();
    transaction(db, () => {
      db.prepare(`INSERT INTO team_reminders(team_id,enabled,sender_user_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(team_id) DO UPDATE SET enabled=excluded.enabled,sender_user_id=excluded.sender_user_id,updated_at=excluded.updated_at`)
        .run(teamId, input.enabled ? 1 : 0, input.enabled ? user : null, now);
      audit(db, teamId, user, 'reminders.update', 'team', teamId, { enabled: input.enabled, senderUserId: input.enabled ? user : null });
    });
    return { reminders: { enabled: input.enabled, senderUserId: input.enabled ? user : null } satisfies TeamReminderSettings };
  });
  const timer = setInterval(() => { void processReminderOutbox(context).catch(() => {}); }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
