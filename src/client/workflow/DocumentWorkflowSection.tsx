import { useEffect, useState } from "react";
import type { DocumentWorkflow, Member, TeamReminderSettings } from "../../shared/types";
import { ApiError, api } from "../api";
import { DocumentWorkflowPanel, type WorkflowSaveInput } from "./DocumentWorkflowPanel";

export function DocumentWorkflowSection({ documentId, teamId, currentUserId, canManage, onError }: {
  documentId: string; teamId: string; currentUserId: string; canManage: boolean; onError(error: unknown): void;
}) {
  const [workflow, setWorkflow] = useState<DocumentWorkflow | null>(null);
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [reminders, setReminders] = useState<TeamReminderSettings>({ enabled: false, senderUserId: null });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setWorkflow(null); setMessage("");
    void Promise.all([
      api.get<{ workflow: DocumentWorkflow }>("/documents/" + documentId + "/workflow"),
      api.get<{ members: Member[] }>("/teams/" + teamId + "/members"),
      canManage ? api.get<{ reminders: TeamReminderSettings }>("/teams/" + teamId + "/reminders") : Promise.resolve({ reminders: { enabled: false, senderUserId: null } as TeamReminderSettings }),
    ]).then(([w, m, r]) => {
      if (!active) return;
      setWorkflow(w.workflow); setMembers(m.members); setReminders(r.reminders);
    }).catch((error: unknown) => {
      if (!active) return;
      if (!(error instanceof ApiError && error.status === 404)) onError(error);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [documentId, teamId, canManage, onError, open]);

  const save = async (input: WorkflowSaveInput) => {
    const body = input;
    const result = await api.patch<{ workflow: DocumentWorkflow }>("/documents/" + documentId + "/workflow", body);
    setWorkflow(result.workflow); setMessage("文档计划已保存。");
  };
  const markReviewed = async () => {
    if (!workflow) return;
    try {
      const result = await api.post<{ workflow: DocumentWorkflow }>("/documents/" + documentId + "/workflow/mark-reviewed", { metadataVersion: workflow.metadataVersion });
      setWorkflow(result.workflow); setMessage("已记录复核时间。");
    } catch (error) { onError(error); }
  };
  return <section className="workflow-section-wrap" aria-label="文档计划区域">
    <button className="secondary-button workflow-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起负责人与复核计划" : "负责人、复核与到期计划"}</button>
    {open && (loading ? <div className="agent-loading">正在读取负责人和复核计划…</div> : workflow ? <>
      <DocumentWorkflowPanel workflow={workflow} members={members} canManage={canManage} remindersConfigured={reminders.enabled} onSave={save} onMarkReviewed={markReviewed} canMarkReviewed={canManage || workflow.responsibleUserId === currentUserId} />
      {message && <div className="inline-note" role="status">{message}</div>}
    </> : <div className="form-error" role="alert">无法读取文档计划。</div>)}
  </section>;
}
