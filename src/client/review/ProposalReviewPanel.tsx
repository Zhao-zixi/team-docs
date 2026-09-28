import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clock3, FilePlus2, History, RotateCcw, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { Document, Proposal, ProposalKind, ProposalStatus, ProposalSummary } from "../../shared/types";
import { ReviewDiff } from "./ReviewDiff";

const kindLabel: Record<ProposalKind, string> = { create: "新建文档", update: "更新文档", restore: "恢复版本", delete: "删除文档" };
const statusLabel: Record<ProposalStatus, string> = { pending: "待审阅", approved: "已批准", rejected: "已驳回", withdrawn: "已撤回", conflicted: "版本冲突" };
const kindIcon = (kind: ProposalKind) => kind === "create" ? <FilePlus2 size={15}/> : kind === "restore" ? <History size={15}/> : kind === "delete" ? <Trash2 size={15}/> : <RotateCcw size={15}/>;

export interface ProposalReviewPanelProps {
  teamId: string;
  currentUserId: string;
  canReview: boolean;
  documentTitles?: ReadonlyMap<string, string>;
  onChanged?(): void;
}

function safeLink(href?: string) {
  if (!href) return undefined;
  try { const url = new URL(href, window.location.origin); return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : undefined; }
  catch { return undefined; }
}

export function ProposalReviewPanel({ teamId, currentUserId, canReview, documentTitles, onChanged }: ProposalReviewPanelProps) {
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [baseline, setBaseline] = useState<Document | null>(null);
  const [status, setStatus] = useState<ProposalStatus | "all">("pending");
  const [mineOnly, setMineOnly] = useState(!canReview);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++requestId.current; setLoading(true); setError("");
    try {
      const params = new URLSearchParams(); if (status !== "all") params.set("status", status); if (mineOnly || !canReview) params.set("mine", "true");
      const query = params.size ? `?${params.toString()}` : "";
      const result = await api.get<{ proposals: ProposalSummary[] }>(`/teams/${teamId}/proposals${query}`);
      if (current === requestId.current) setItems(result.proposals);
    } catch (cause) {
      if (current === requestId.current) setError(cause instanceof ApiError && cause.status === 403 ? "你没有查看团队审阅队列的权限。" : cause instanceof Error ? cause.message : "无法加载提案列表。");
    } finally { if (current === requestId.current) setLoading(false); }
  }, [teamId, status, mineOnly, canReview]);

  useEffect(() => { void refresh(); return () => { requestId.current++; }; }, [refresh]);

  const open = async (item: ProposalSummary) => {
    const current = ++requestId.current; setSelected(null); setError(""); setLoading(true);
    try {
      const { proposal } = await api.get<{ proposal: Proposal }>(`/proposals/${item.id}`);
      if (current !== requestId.current) return;
      setSelected(proposal); setBaseline(null);
      if (proposal.documentId && proposal.kind !== "create") {
        try { const { document } = await api.get<{ document: Document }>(`/documents/${proposal.documentId}`); if (current === requestId.current) setBaseline(document); }
        catch { /* A proposal can remain reviewable even when the live document is no longer visible to its author. */ }
      }
    } catch (cause) { if (current === requestId.current) setError(cause instanceof Error ? cause.message : "无法读取提案正文。"); }
    finally { if (current === requestId.current) setLoading(false); }
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!selected || selected.authorId === currentUserId || !canReview) return;
    setBusy(true); setError("");
    try {
      await api.post(`/proposals/${selected.id}/decision`, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
      setSelected(null); setNote(""); await refresh(); onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? "提案基线已变化或提案状态已更新。请重新加载后核对差异。" : cause instanceof ApiError && cause.status === 403 ? "服务端拒绝此审核操作。" : cause instanceof Error ? cause.message : "提交审核决定失败。");
    } finally { setBusy(false); }
  };

  const withdraw = async (proposal: ProposalSummary) => {
    if (proposal.authorId !== currentUserId) return;
    setBusy(true); setError("");
    try { await api.post(`/proposals/${proposal.id}/withdraw`, {}); setSelected(null); await refresh(); onChanged?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "撤回提案失败。"); }
    finally { setBusy(false); }
  };

  return <section className="proposal-review-panel" aria-label="提案审阅">
    <header className="proposal-panel-head"><div><span className="eyebrow">团队协作</span><h2>{canReview ? "提案审阅" : "我的提案"}</h2><p>空间启用审阅后，正式文档只会在其他管理员批准提案后更新。</p></div><div className="proposal-filter-group">{canReview&&<label className="proposal-mine-filter"><input type="checkbox" checked={mineOnly} onChange={event=>setMineOnly(event.currentTarget.checked)}/>只看我提交的</label>}<label className="proposal-filter">状态<select aria-label="提案状态" value={status} onChange={event => setStatus(event.currentTarget.value as ProposalStatus | "all")}><option value="pending">待审阅</option><option value="approved">已批准</option><option value="rejected">已驳回</option><option value="conflicted">有冲突</option><option value="all">全部</option></select></label></div></header>
    {error && <div className="form-error" role="alert">{error}</div>}
    {loading && !items.length && <div className="agent-loading">正在加载提案…</div>}
    {!loading && !items.length && <div className="agent-empty"><Clock3 size={19}/><strong>没有{status === "pending" ? "待审阅" : "匹配"}提案</strong><span>新建、更新、恢复或删除操作可按空间审阅规则提交。</span></div>}
    <div className="proposal-list">{items.map(item => <button type="button" className="proposal-row" key={item.id} onClick={() => void open(item)}>
      <span className={`proposal-kind-icon ${item.kind}`}>{kindIcon(item.kind)}</span><span className="proposal-row-copy"><strong>{item.title || "未命名文档"}</strong><small>{item.authorName} · {kindLabel[item.kind]}{item.kind === "create" ? (item.parentId ? ` · 子文档，父文档：${documentTitles?.get(item.parentId) ?? `上级文档（ID: ${item.parentId.slice(0, 8)}）`}` : " · 根文档") : ""} · {new Date(item.createdAt).toLocaleString("zh-CN")}</small></span><span className={`proposal-status ${item.status}`}>{statusLabel[item.status]}</span>
    </button>)}</div>
    {selected && <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setSelected(null); }}>
      <section className="modal-card proposal-detail-card" role="dialog" aria-modal="true" aria-labelledby="proposal-detail-title">
        <header className="modal-head"><div><span className="eyebrow">{kindLabel[selected.kind]} · {statusLabel[selected.status]}</span><h2 id="proposal-detail-title">{selected.title || "未命名文档"}</h2></div><button className="icon-button" aria-label="关闭提案详情" onClick={() => setSelected(null)}><X/></button></header>
        <div className="modal-body proposal-detail-body">
          <div className="proposal-meta"><span>提交者：{selected.authorName}</span>{selected.kind === "create"&&<span>{selected.parentId?`父文档：${documentTitles?.get(selected.parentId)??`上级文档（ID: ${selected.parentId.slice(0, 8)}）`}`:"根文档（无父文档）"}</span>}<span>基于版本：{selected.baseVersion ?? "新文档"}</span>{baseline&&<span>当前正式版本：v{baseline.version}</span>}<span>提交时间：{new Date(selected.createdAt).toLocaleString("zh-CN")}</span></div>
          {selected.kind === "delete" ? <div className="inline-note"><Trash2 size={15}/>批准后会删除正式文档，提案与审计记录仍会保留。</div> : <>
            {selected.kind !== "create" && <section className="proposal-baseline"><strong>当前正式内容版本 {selected.baseVersion ?? "—"}</strong><p>请在文档历史或正文中核对当前版本后再决定。</p></section>}
            {selected.kind === "create" ? <article className="proposal-markdown"><pre>{selected.body}</pre></article> : baseline ? <ReviewDiff before={`${baseline.title}`+"\n"+baseline.body} after={`${selected.title}`+"\n"+selected.body} beforeLabel={`当前正式内容 v${baseline.version}`} afterLabel="提案内容"/> : <article className="proposal-markdown"><strong>提案内容</strong><pre>{selected.body}</pre></article>}
          </>}
          {selected.decisionNote && <p className="proposal-decision-note">决定说明：{selected.decisionNote}</p>}
          {selected.status === "pending" && selected.authorId === currentUserId && <p className="inline-note">你不能批准自己的提案。可在下方撤回后修改并重新提交。</p>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {selected.status === "pending" && selected.authorId !== currentUserId && canReview && <label className="proposal-note-field">审核说明<textarea aria-label="审核说明" value={note} onChange={event => setNote(event.currentTarget.value)} maxLength={2000} rows={3}/></label>}
        </div>
        <footer className="modal-foot"><span className="muted-text">决定时服务端会重新核对当前身份、权限和基线版本。</span><div>
          {selected.status === "pending" && selected.authorId === currentUserId && <button className="secondary-button" disabled={busy} onClick={() => void withdraw(selected)}>撤回提案</button>}
          {selected.status === "pending" && selected.authorId !== currentUserId && canReview && <><button className="secondary-button" disabled={busy} onClick={() => void decide("reject")}><X size={14}/>驳回</button><button className="primary-button" disabled={busy} onClick={() => void decide("approve")}><Check size={14}/>{busy ? "处理中…" : "批准提案"}</button></>}
        </div></footer>
      </section>
    </div>}
  </section>;
}
