import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, LoaderCircle, Radio, X } from "lucide-react";
import * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import type { Document, Draft, DraftMode } from "../../shared/types";
import { ApiError, api } from "../api";
import { closeDraftCollaboration, createDraftWebsocketProvider } from "./provider";
import { CollaborativeDraftEditor } from "./CollaborativeDraftEditor";
import { DocumentCommentsSection } from "../comments/DocumentCommentsSection";
import type { CommentAnchor } from "../../shared/types";
import { ReviewDiff } from "../review/ReviewDiff";

type Projection = { ok: true; title: string; body: string } | { ok: false; reason: string };
type Session = { document: Y.Doc; provider: WebsocketProvider };

export function CollaborativeDraftPanel({ document, teamId, userName, close, onPublished, onAccessLost, onError }: {
  document: Document; teamId: string; userName: string; close(): void; onPublished(document: Document): void; onAccessLost(): void; onError(error: unknown): void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [sync, setSync] = useState<"connecting" | "connected" | "disconnected" | "synced">("connecting");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [selectedComment, setSelectedComment] = useState<{quote:string;anchor:CommentAnchor}|null>(null);
  const [finished, setFinished] = useState(false);
  const [rebaseCandidate, setRebaseCandidate] = useState<Document | null>(null);
  const generation = useRef(0);
  const finishingRef = useRef(false);
  const onAccessLostRef = useRef(onAccessLost);
  useEffect(() => { onAccessLostRef.current = onAccessLost; }, [onAccessLost]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(""); setMessage("");
    try {
      const result = await api.get<{ draft: Draft }>(`/documents/${document.id}/draft`);
      if (current === generation.current) setDraft(result.draft);
    } catch (cause) {
      if (current !== generation.current) return;
      if (cause instanceof ApiError && cause.status === 404) setDraft(null);
      else { setError(cause instanceof Error ? cause.message : "无法读取协作草稿。"); if (cause instanceof ApiError && [401,403].includes(cause.status)) onError(cause); }
    } finally { if (current === generation.current) setLoading(false); }
  }, [document.id, onError]);

  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => {
    if (!draft) return;
    const ydoc = new Y.Doc();
    let provider: WebsocketProvider;
    try { provider = createDraftWebsocketProvider(ydoc, draft.id); }
    catch (cause) { ydoc.destroy(); setError(cause instanceof Error ? cause.message : "无法连接协作服务。"); return; }
    provider.awareness.setLocalStateField("user", { name: userName, color: "#527f69" });
    const handleSync = () => setSync(provider.synced ? "synced" : provider.wsconnected ? "connected" : "connecting");
    const handleStatus = ({ status }: { status: "connected" | "disconnected" | "connecting" }) => setSync(status);
    const handleClosed = ({ code, reason }: { code: number; reason: string }) => {
      if (code === 4403 && reason === "draft frozen" && finishingRef.current) { setSync("disconnected"); return; }
      if (code >= 4400 && code <= 4499) {
        setSession(null); setProjection(null); setError(code === 4401 ? "登录状态已失效，协作内容已清除。" : "文档权限或草稿状态已变化，协作内容已清除。");
        onAccessLostRef.current();
      }
    };
    provider.on("sync", handleSync); provider.on("status", handleStatus); provider.on("closed", handleClosed);
    const mounted = { document: ydoc, provider };
    setSession(mounted);
    return () => {
      provider.off("sync", handleSync); provider.off("status", handleStatus); provider.off("closed", handleClosed);
      closeDraftCollaboration(provider, ydoc);
    };
  }, [draft?.id]);

  async function start(mode: DraftMode) {
    setBusy(true); setError("");
    try { const result = await api.post<{ draft: Draft }>(`/documents/${document.id}/draft`, { mode }); setDraft(result.draft); setMessage(mode === "markdown" ? "已创建 Markdown 协作草稿。" : "已创建富文本协作草稿。"); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { await load(); setMessage("另一位成员已开始协作，本页已载入同一份草稿。"); }
      else { setError(cause instanceof Error ? cause.message : "创建协作草稿失败。"); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) onError(cause); }
    } finally { setBusy(false); }
  }

  const onProjection = useCallback((value: Projection) => setProjection(value), []);
  const onSyncState = useCallback((value: typeof sync) => setSync(value), []);
  const offerRebaseIfStale = useCallback(async () => {
    if (!draft || !projection?.ok) return false;
    try {
      const latest = await api.get<{ document: Document }>("/documents/" + document.id);
      if (latest.document.version > draft.baseVersion) {
        setRebaseCandidate(latest.document);
        setError("正式文档已更新。请先比较差异，再明确确认是否保留当前协作草稿并以新版本为基线。");
        return true;
      }
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) onError(cause);
    }
    return false;
  }, [document.id, draft, onError, projection]);

  async function rebaseDraft() {
    if (!draft || !projection?.ok || !rebaseCandidate || !session || sync !== "synced" || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const latestDraft = await api.get<{ draft: Draft }>("/documents/" + document.id + "/draft");
      if (latestDraft.draft.id !== draft.id || latestDraft.draft.state !== "editing") {
        throw new ApiError("CONFLICT", "草稿状态已变化，请重新载入后再确认。", 409);
      }
      const result = await api.post<{ draft: Draft; previousBaseVersion: number }>("/documents/" + document.id + "/draft/rebase", {
        expectedSeq: latestDraft.draft.seq,
        expectedBaseVersion: latestDraft.draft.baseVersion,
        expectedDocumentVersion: rebaseCandidate.version,
        expectedTitle: projection.title,
        expectedBody: projection.body,
        acknowledged: true,
      });
      setDraft(result.draft);
      setRebaseCandidate(null);
      onPublished(rebaseCandidate);
      setMessage("已将草稿基线更新到版本 " + result.draft.baseVersion + "，协作内容完整保留。请复核后再次发布。");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const latest = await api.get<{ document: Document }>("/documents/" + document.id);
          if (latest.document.version > draft.baseVersion) setRebaseCandidate(latest.document);
        } catch (readError) {
          if (readError instanceof ApiError && [401, 403, 404].includes(readError.status)) onError(readError);
        }
        setError("草稿或正式版本又发生变化，草稿内容仍保留。请重新检查下方差异并再次明确确认；若有待审提案，请先处理提案。");
      } else {
        setError(cause instanceof Error ? cause.message : "同步草稿基线失败，草稿内容仍保留。");
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) onError(cause);
      }
    } finally { setBusy(false); }
  }
  async function finishDraft() {
    if (!draft || !session || !projection?.ok || sync !== "synced") return;
    finishingRef.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const latest = await api.get<{ draft: Draft }>(`/documents/${document.id}/draft`);
      if (latest.draft.id !== draft.id || latest.draft.state !== "editing") throw new ApiError("CONFLICT", "协作草稿状态已变化，请重新载入。", 409);
      const expected = { expectedSeq: latest.draft.seq, expectedBaseVersion: draft.baseVersion, expectedTitle: projection.title, expectedBody: projection.body };
      try {
        await api.post(`/documents/${document.id}/draft/publish`, expected);
        const latestDoc = await api.get<{ document: Document }>(`/documents/${document.id}`);
        setFinished(true); setMessage("协作草稿已发布为新的正式版本。"); onPublished(latestDoc.document);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.code !== "REVIEW_REQUIRED") throw cause;
        await api.post(`/documents/${document.id}/draft/submit`, expected);
        setFinished(true); setMessage("协作草稿已提交审核；正式文档保持不变，待其他管理员批准。");
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { const stale = await offerRebaseIfStale(); if (!stale) setError("协作草稿尚未同步，或存在待审提案。内容仍保留在服务器草稿中；请等待同步，或先处理待审提案后重试。"); }
      else { setError(cause instanceof Error ? cause.message : "发布协作草稿失败。"); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) onError(cause); }
    } finally { finishingRef.current = false; setBusy(false); }
  }

  function requestClose() {
    if (!finished && draft && projection?.ok && (projection.title !== document.title || projection.body !== document.body)
      && !window.confirm("协作草稿保存在服务器，但尚未发布。关闭面板后仍可从文档重新进入，确定关闭吗？")) return;
    close();
  }

  const ready = Boolean(draft && session && sync === "synced" && projection?.ok && !finished);
  function captureDraftSelection() {
    const quote = window.getSelection()?.toString().trim() ?? "";
    if (!quote || !projection?.ok) return;
    const index = projection.body.indexOf(quote);
    if (index < 0) { setSelectedComment(null); setError("当前选区无法对应到草稿 Markdown。请选择一段纯文本后再评论。"); return; }
    const before = projection.body.slice(0,index); const blocks = before.split(/\n\s*\n/);
    setSelectedComment({ quote, anchor: { paragraphIndex: blocks.length - 1, startOffset: blocks.at(-1)?.length ?? 0, endOffset: (blocks.at(-1)?.length ?? 0) + quote.length } });
  }
  return <div className="modal-scrim collab-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) requestClose(); }}>
    <section className="modal-card collab-dialog" role="dialog" aria-modal="true" aria-labelledby="collab-dialog-title">
      <header className="modal-head"><div><span className="eyebrow">{document.title}</span><h2 id="collab-dialog-title">多人协作草稿</h2></div><button className="icon-button" aria-label="关闭协作草稿" disabled={busy} onClick={requestClose}><X/></button></header>
      {error && <div className="form-error collab-dialog-message" role="alert">{error}</div>}
      {message && <div className="inline-note collab-dialog-message" role="status">{message}</div>}
      <div className="collab-dialog-body">
        {loading ? <div className="agent-loading"><LoaderCircle size={16}/>正在读取协作草稿…</div> : !draft ? <div className="collab-mode-choice">
          <p>草稿会与团队成员实时同步，编辑模式创建后固定。正式文档只在此处发布或提交审核后改变。</p>
          <button className="secondary-button" disabled={busy} onClick={() => void start("markdown")}><FileText size={16}/>创建 Markdown 协作草稿</button>
          <button className="primary-button" disabled={busy} onClick={() => void start("rich")}><Radio size={16}/>创建富文本协作草稿</button>
        </div> : finished ? <div className="collab-finished"><Check size={28}/><strong>{message}</strong><button className="secondary-button" onClick={close}>关闭</button></div> : !session || sync !== "synced" ? <div className="agent-loading"><LoaderCircle size={16}/>正在连接并同步草稿…</div> : <>
          <div className="collab-submit-note">同一草稿中的成员正在协作。断线后会重连并从服务器恢复；空间规则决定发布还是提交审核。</div>
          {projection && !projection.ok && <div className="form-error" role="alert">{projection.reason}。请修复正文后再发布，草稿仍保留。</div>}
          {rebaseCandidate && projection?.ok && <section className="collab-rebase" aria-label="同步草稿基线确认">
            <h3>正式文档已到版本 {rebaseCandidate.version}</h3>
            <p>确认后只更新草稿基线，当前协作内容不会被正式版本覆盖。</p>
            <ReviewDiff before={rebaseCandidate.title + "\n\n" + rebaseCandidate.body} after={projection.title + "\n\n" + projection.body} beforeLabel={"正式版本 " + rebaseCandidate.version} afterLabel="当前协作草稿" />
            <button className="secondary-button" disabled={!session || sync !== "synced" || busy} onClick={() => void rebaseDraft()}>{busy ? "正在核对版本…" : "以版本 " + rebaseCandidate.version + " 为新基线，保留当前草稿"}</button>
          </section>}
          <div onMouseUp={captureDraftSelection} onKeyUp={captureDraftSelection}><CollaborativeDraftEditor mode={draft.mode} document={session.document} provider={session.provider} canWrite={document.canEdit && draft.state === "editing"} presenceUser={{ name: userName, color: "#527f69" }} onProjection={onProjection} onSyncState={onSyncState}/></div>
          <div className="collab-publish-row"><span className="muted-text">{sync === "synced" ? "与服务器连接正常" : "连接中，发布暂不可用"}</span><div className="collab-actions"><button className="secondary-button" disabled={!draft} onClick={()=>setCommentsOpen(value=>!value)}>{commentsOpen?"关闭草稿讨论":"草稿讨论"}</button><button className="primary-button" disabled={!ready || busy} onClick={() => void finishDraft()}>{busy ? "正在提交…" : "发布 / 提交审核"}</button></div></div>{commentsOpen&&draft&&<DocumentCommentsSection documentId={document.id} teamId={teamId} source={{kind:"draft",draftId:draft.id,seq:draft.seq}} selectedText={selectedComment} canWrite={document.canEdit&&draft.state==="editing"} onError={onError}/>}
        </>}
      </div>
    </section>
  </div>;
}
