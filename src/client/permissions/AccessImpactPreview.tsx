import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ShieldCheck, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { AccessFlags, AccessImpactPreview, AccessReason, Grant, Visibility } from "../../shared/types";

export interface AccessPreviewTarget {
  kind: "space" | "document";
  id: string;
  teamId: string;
  spaceId: string;
}

export interface AccessImpactPreviewProps {
  target: AccessPreviewTarget;
  subjectUserId: string;
  subjectName: string;
  visibility: Visibility | "inherit";
  grants: Grant[];
  onClose(): void;
  onApply(): void;
}

interface ExplainResult {
  resource: { kind: "space" | "document"; id: string };
  subject: { id: string; name: string; teamRole: string };
  effective: AccessFlags;
  reasons: AccessReason[];
}

const roleLabel = (flags: AccessFlags) => flags.canManage ? "管理" : flags.canEdit ? "编辑" : flags.canRead ? "阅读" : "无权访问";

function Reasons({ reasons }: { reasons: AccessReason[] }) {
  if (!reasons.length) return <span>没有可见权限来源</span>;
  return <ul className="access-reason-list">{reasons.map((reason, index) => <li key={`${reason.layer}-${reason.code}-${index}`}><b>{reason.layer === "team" ? "团队" : reason.layer === "space" ? "知识库" : "文档"}</b><span>{reason.code}{reason.visibility ? ` · ${reason.visibility}` : ""}{reason.grantRole ? ` · ${reason.grantRole}` : ""}</span></li>)}</ul>;
}

export function AccessImpactPreview({ target, subjectUserId, subjectName, visibility, grants, onClose, onApply }: AccessImpactPreviewProps) {
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [preview, setPreview] = useState<AccessImpactPreview | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const generation = useRef(0);
  const targetKey = `${target.kind}:${target.id}:${target.teamId}:${target.spaceId}:${subjectUserId}`;
  const accessPath = target.kind === "space" ? `/spaces/${target.id}/access` : `/documents/${target.id}/access`;
  const explainPath = target.kind === "space" ? `/spaces/${target.id}/access/explain` : `/documents/${target.id}/access/explain`;

  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    setExplain(null); setPreview(null); setError(""); setLoading(true); setOffset(0);
    void Promise.all([
      api.get<ExplainResult>(`${explainPath}?userId=${encodeURIComponent(subjectUserId)}`),
      api.post<AccessImpactPreview>(`${accessPath}/preview`, { visibility, grants, offset: 0, limit: 50 }),
    ]).then(([e, p]) => {
      if (!active || generation.current !== current) return;
      setExplain(e); setPreview(p);
    }).catch((cause: unknown) => {
      if (!active || generation.current !== current) return;
      setError(cause instanceof ApiError && cause.status === 404 ? "资源或成员访问状态已变化，请关闭后重新打开。" : cause instanceof Error ? cause.message : "无法加载权限解释和影响预览。");
    }).finally(() => { if (active && generation.current === current) setLoading(false); });
    return () => { active = false; generation.current++; };
  }, [targetKey, explainPath, accessPath, subjectUserId, visibility, grants]);

  const loadMore = async () => {
    if (!preview?.hasMore || preview.nextOffset == null || loading) return;
    const current = generation.current; setLoading(true); setError("");
    try {
      const next = await api.post<AccessImpactPreview>(`${accessPath}/preview`, { visibility, grants, offset: preview.nextOffset, limit: 50 });
      if (current !== generation.current) return;
      setPreview({ ...next, changes: [...preview.changes, ...next.changes] }); setOffset(next.nextOffset ?? offset);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "无法加载下一页。"); }
    finally { if (current === generation.current) setLoading(false); }
  };

  const apply = async () => {
    const current = generation.current; setApplying(true); setError("");
    try {
      await api.put(accessPath, { visibility, grants });
      if (current === generation.current) onApply();
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof ApiError && cause.status === 409 ? "权限数据已变化。关闭窗口重新加载后再应用。" : cause instanceof Error ? cause.message : "权限保存失败。");
    } finally { if (current === generation.current) setApplying(false); }
  };

  return <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !applying) onClose(); }}>
    <section className="modal-card access-preview-card" role="dialog" aria-modal="true" aria-labelledby="access-preview-title">
      <header className="modal-head"><div><span className="eyebrow">权限体检</span><h2 id="access-preview-title">访问解释与变更预览</h2></div><button className="icon-button" aria-label="关闭权限预览" disabled={applying} onClick={onClose}><X/></button></header>
      <div className="modal-body access-preview-body">
        {error && <div className="form-error" role="alert">{error}</div>}
        <p className="inline-note"><ShieldCheck size={16}/>权限结果来自服务端当前策略。owner/admin 可查看团队内所有知识库和文档，包括受限内容；此面板不会在浏览器自行计算权限。</p>
        <section className="access-subject-card"><span className="eyebrow">指定成员</span><strong>{subjectName}</strong>{loading && <span>正在从服务端读取…</span>}{explain && <><span className={`access-role-chip ${explain.effective.canRead ? "allowed" : "blocked"}`}>{roleLabel(explain.effective)}</span><Reasons reasons={explain.reasons}/></>}</section>
        <section className="access-impact-section"><div className="access-impact-heading"><div><span className="eyebrow">拟议变更</span><h3>受影响成员与文档</h3></div>{preview && <span>{preview.totals.membersChanged} 位成员变化</span>}</div>
          {preview && <div className="access-impact-totals"><span><ArrowUp size={14}/>阅读 +{preview.totals.readGained}</span><span><ArrowDown size={14}/>阅读 −{preview.totals.readLost}</span><span><ArrowUp size={14}/>编辑 +{preview.totals.editGained}</span><span><ArrowDown size={14}/>编辑 −{preview.totals.editLost}</span></div>}
          {!loading && preview && preview.changes.length === 0 && <div className="agent-empty"><strong>这项设置不会改变成员的有效权限</strong><span>服务端没有返回受影响成员。</span></div>}
          <div className="access-impact-list">{preview?.changes.map(change => <article className="access-impact-row" key={change.userId}><strong>{change.name}</strong><div className="access-impact-state"><span>{roleLabel(change.before)}</span><b>→</b><span>{roleLabel(change.after)}</span></div><div className="access-impact-detail"><span>读取文档 {change.documentsReadGained > 0 ? `+${change.documentsReadGained}` : change.documentsReadGained}</span><span>编辑文档 {change.documentsEditGained > 0 ? `+${change.documentsEditGained}` : change.documentsEditGained}</span></div><details className="access-change-reasons"><summary>查看权限来源</summary><div><b>当前</b><Reasons reasons={change.beforeReasons}/></div><div><b>应用后</b><Reasons reasons={change.afterReasons}/></div></details>{!change.after.canRead && <span className="access-warning"><AlertTriangle size={13}/>保存后此成员将无法读取</span>}</article>)}</div>
          {preview?.hasMore && <button className="secondary-button" disabled={loading} onClick={() => void loadMore()}>{loading ? "加载中…" : "继续查看成员"}</button>}
        </section>
      </div>
      <footer className="modal-foot"><span className="muted-text">应用后仍由服务端逐次校验文档与知识库权限。</span><div><button className="secondary-button" disabled={applying} onClick={onClose}>取消</button><button className="primary-button" disabled={!preview || loading || applying} onClick={() => void apply()}>{applying ? "应用中…" : "确认并应用"}</button></div></footer>
    </section>
  </div>;
}
