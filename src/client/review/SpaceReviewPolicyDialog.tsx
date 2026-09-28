import { useEffect, useRef, useState } from "react";
import { FileCheck2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { Space } from "../../shared/types";

export function SpaceReviewPolicyDialog({ open, space, close, onSaved }: { open: boolean; space: Space | null; close(): void; onSaved(enabled: boolean): void }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    if (!open || !space) return;
    const current = ++generation.current; setLoaded(false); setError("");
    void api.get<{ requireReview: boolean }>(`/spaces/${space.id}/review-policy`).then(result => {
      if (current === generation.current) { setEnabled(result.requireReview); setLoaded(true); }
    }).catch(cause => {
      if (current !== generation.current) return;
      setError(cause instanceof ApiError && cause.status === 403 ? "只有知识库管理员可以修改审阅规则。" : cause instanceof Error ? cause.message : "无法加载审阅规则。");
      setLoaded(true);
    });
    return () => { generation.current++; };
  }, [open, space?.id]);
  if (!open || !space) return null;
  const save = async () => {
    const current = generation.current; setBusy(true); setError("");
    try {
      await api.put(`/spaces/${space.id}/review-policy`, { requireReview: enabled });
      if (current !== generation.current) return;
      onSaved(enabled); close();
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof ApiError && cause.status === 404 ? "知识库或设置入口已变化，请重新打开。" : cause instanceof Error ? cause.message : "保存审阅规则失败。");
    } finally { if (current === generation.current) setBusy(false); }
  };
  return <div className="modal-scrim" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close();}}><section className="modal-card review-policy-card" role="dialog" aria-modal="true" aria-labelledby="review-policy-title"><header className="modal-head"><div><span className="eyebrow">{space.name}</span><h2 id="review-policy-title">变更审阅规则</h2></div><button className="icon-button" aria-label="关闭审阅规则" disabled={busy} onClick={close}><X/></button></header><div className="modal-body">
    {error&&<div className="form-error" role="alert">{error}</div>}
    {!loaded?<div className="agent-loading">正在读取知识库规则…</div>:<>
      <label className="review-policy-toggle"><input type="checkbox" checked={enabled} disabled={busy||!!error} onChange={event=>setEnabled(event.currentTarget.checked)}/><span><strong>所有文档变更都需其他管理员批准</strong><small>启用后，新建、编辑、恢复和删除会先进入提案队列。正式文档在提案批准前保持不变。</small></span></label>
      <div className="inline-note"><FileCheck2 size={15}/>文档访问权限仍由管理员单独管理。审批者不能批准自己的提案；无审批模式下保存与现有流程一致。</div>
    </>}
  </div><footer className="modal-foot"><span className="muted-text">正在处理的提案会保留，不会被规则切换自动批准。</span><div><button className="secondary-button" disabled={busy} onClick={close}>取消</button><button className="primary-button" disabled={!loaded||busy||!!error} onClick={()=>void save()}>{busy?"保存中…":"保存规则"}</button></div></footer></section></div>;
}
