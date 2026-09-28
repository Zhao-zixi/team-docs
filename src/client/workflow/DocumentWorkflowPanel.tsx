import { useEffect, useState } from "react";
import { CalendarClock, Check, Save } from "lucide-react";
import type { DocumentWorkflow, Member } from "../../shared/types";

export interface WorkflowSaveInput {
  responsibleUserId: string | null;
  reviewAt: string | null;
  dueAt: string | null;
  metadataVersion: number;
}

function toLocalInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(value: string) { return value ? new Date(value).toISOString() : null; }

export function DocumentWorkflowPanel({ workflow, members, canManage, canMarkReviewed, remindersConfigured, onSave, onMarkReviewed }: {
  workflow: DocumentWorkflow;
  members: Member[];
  canManage: boolean;
  canMarkReviewed: boolean;
  remindersConfigured: boolean;
  onSave(input: WorkflowSaveInput): Promise<void>;
  onMarkReviewed(): Promise<void>;
}) {
  const [responsibleUserId, setResponsibleUserId] = useState(workflow.responsibleUserId ?? "");
  const [reviewAt, setReviewAt] = useState(toLocalInput(workflow.reviewAt));
  const [dueAt, setDueAt] = useState(toLocalInput(workflow.dueAt));
const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setResponsibleUserId(workflow.responsibleUserId ?? ""); setReviewAt(toLocalInput(workflow.reviewAt));
    setDueAt(toLocalInput(workflow.dueAt)); setError("");
  }, [workflow.documentId, workflow.metadataVersion]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!canManage || busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ responsibleUserId: responsibleUserId || null, reviewAt: fromLocalInput(reviewAt), dueAt: fromLocalInput(dueAt), metadataVersion: workflow.metadataVersion });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存文档计划失败。"); }
    finally { setBusy(false); }
  };
  return <form className="document-workflow" onSubmit={save}>
    <header className="workflow-head"><div><span className="eyebrow">文档计划</span><h2>负责人、复核与到期</h2></div><span className="workflow-version">资料版本 v{workflow.metadataVersion}</span></header>
    <label className="field"><span>负责人</span><select aria-label="文档负责人" value={responsibleUserId} disabled={!canManage||busy} onChange={event=>setResponsibleUserId(event.currentTarget.value)}><option value="">未指定</option>{members.map(member=><option value={member.id} key={member.id}>{member.name} · {member.email}</option>)}</select></label>
    <div className="workflow-dates"><label className="field"><span><CalendarClock size={13}/>下次复核</span><input type="datetime-local" aria-label="下次复核时间" value={reviewAt} disabled={!canManage||busy} onChange={event=>setReviewAt(event.currentTarget.value)}/></label><label className="field"><span>到期时间</span><input type="datetime-local" aria-label="到期时间" value={dueAt} disabled={!canManage||busy} onChange={event=>setDueAt(event.currentTarget.value)}/></label></div>
    <div className="workflow-status-line"><span>当前状态</span><strong>{workflow.status === "draft" ? "编辑中" : workflow.status === "in_review" ? "待审核" : "已发布"}</strong>{workflow.lastReviewedAt&&<small>上次复核 {new Date(workflow.lastReviewedAt).toLocaleString("zh-CN")}</small>}</div>
    <p className="workflow-reminder-note">{remindersConfigured ? "团队已配置提醒发件人。提醒计划按本地时区编辑，保存为标准时间。" : "团队尚未配置提醒发件人；计划会保留为站内待办，不会向外发送邮件。"}</p>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {canManage&&<button className="primary-button" disabled={busy}><Save size={14}/>{busy?"保存中…":"保存计划"}</button>}
    {!canManage&&<div className="inline-note"><Check size={14}/>计划信息为只读；只有可管理此文档的成员能修改。</div>}
    {canMarkReviewed&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void onMarkReviewed()}><Check size={14}/>标记已复核</button>}
  </form>;
}
