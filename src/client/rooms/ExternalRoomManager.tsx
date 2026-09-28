import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Eye, EyeOff, History, KeyRound, RotateCw, ShieldOff, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentSummary, ExternalRoomItem, ExternalRoomSummary } from "../../shared/types";

export interface ExternalRoomCreateInput {
  name: string;
  expiresAt: string;
  password: string;
  items: Array<Pick<ExternalRoomItem, "documentId" | "publishedVersion">>;
}
export interface RoomAccessEvent { id: string; accessedAt: string; outcome: string }
export interface ExternalRoomManagerProps {
  teamId: string;
  rooms: ExternalRoomSummary[];
  documents: Array<DocumentSummary & { publishedVersions: number[] }>;
  canManage: boolean;
  onCreate(input: ExternalRoomCreateInput): Promise<{ room: ExternalRoomSummary; url: string }>;
  onRotate(roomId: string): Promise<{ url: string }>;
  onRevoke(roomId: string): Promise<void>;
  onAccessLog(roomId: string): Promise<RoomAccessEvent[]>;
}

export function ExternalRoomManager({ teamId, rooms, documents, canManage, onCreate, onRotate, onRevoke, onAccessLog }: ExternalRoomManagerProps) {
  const [name, setName] = useState("");
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [oneTimeUrl, setOneTimeUrl] = useState("");
  const [secretKind, setSecretKind] = useState<"created"|"rotated">("created");
  const [secretCopied, setSecretCopied] = useState(false);
  const [logs, setLogs] = useState<{ roomId: string; events: RoomAccessEvent[] } | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const availableDocuments = useMemo(() => documents.filter(document => document.canManage), [documents]);
  useEffect(() => { setOneTimeUrl(""); setSecretCopied(false); setName(""); setPassword(""); setSelected({}); setLogs(null); setError(""); }, [teamId]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManage || !name.trim() || !password || !Object.keys(selected).length) return;
    setBusyId("create"); setError(""); setOneTimeUrl("");
    try {
      const result = await onCreate({ name: name.trim(), expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(), password, items: Object.entries(selected).map(([documentId,publishedVersion])=>({documentId,publishedVersion})) });
      setOneTimeUrl(result.url); setSecretKind("created"); setSecretCopied(false); setPassword(""); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建外部资料室。"); }
    finally { setBusyId(""); }
  };

  const rotate = async (roomId: string) => {
    setBusyId(roomId); setError(""); setOneTimeUrl("");
    try { const result = await onRotate(roomId); setOneTimeUrl(result.url); setSecretKind("rotated"); setSecretCopied(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法轮换资料室链接。"); }
    finally { setBusyId(""); }
  };
  const revoke = async (roomId: string) => {
    if (!window.confirm("撤销后，访客将无法继续打开此资料室。确认撤销？")) return;
    setBusyId(roomId); setError("");
    try { await onRevoke(roomId); setLogs(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "撤销资料室失败。"); }
    finally { setBusyId(""); }
  };
  const showLogs = async (roomId: string) => {
    setBusyId(roomId); setError("");
    try { const events = await onAccessLog(roomId); setLogs({roomId,events}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取访客访问记录。"); }
    finally { setBusyId(""); }
  };
  const copySecret = async () => {
    try { await navigator.clipboard.writeText(oneTimeUrl); setSecretCopied(true); }
    catch { setError("复制失败，请选择下方链接文本手动复制。"); }
  };

  return <section className="external-room-manager" aria-label="外部资料室管理">
    <header className="room-manager-head"><div><span className="eyebrow">外部分享</span><h2>资料室</h2><p>只展示你选择的正式文档版本；访客不会看到团队、知识库、作者或内部历史信息。</p></div><span className="room-security-tag"><KeyRound size={13}/>口令与有效期保护</span></header>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {oneTimeUrl&&<section className="room-secret-panel" aria-label="一次性资料室链接"><div><strong>{secretKind==="created"?"资料室已创建":"访问链接已轮换"}</strong><span>此链接只显示这一次。关闭本面板后不会再次回显；遗失请轮换链接。</span></div><label>访客链接<input aria-label="一次性访客链接" readOnly value={oneTimeUrl} onFocus={event=>event.currentTarget.select()}/></label><div className="room-secret-actions"><button className="primary-button compact" onClick={()=>void copySecret()}><Copy size={14}/>{secretCopied?"已复制":"复制链接"}</button><button className="secondary-button compact" onClick={()=>{setOneTimeUrl("");setSecretCopied(false);}}>关闭并清除</button></div></section>}
    {canManage&&<form className="room-create-form" onSubmit={create}>
      <div className="room-create-title"><strong>新建资料室</strong><span>仅分享已选中的发布版本</span></div>
      <div className="room-create-grid"><label className="field"><span>名称</span><input required maxLength={80} value={name} onChange={event=>setName(event.currentTarget.value)} placeholder="例如：合作方资料包"/></label><label className="field"><span>有效期</span><select value={days} onChange={event=>setDays(event.currentTarget.value)}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label><label className="field room-password-field"><span>访客口令</span><input required type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.currentTarget.value)} placeholder="设置独立口令"/></label></div>
      <fieldset className="room-doc-picker"><legend>选择文档与正式版本</legend>{availableDocuments.map(document=><label className="room-doc-choice" key={document.id}><input type="checkbox" checked={selected[document.id]!==undefined} onChange={event=>{const checked=event.currentTarget.checked;setSelected(current=>{const next={...current};if(checked)next[document.id]=document.version;else delete next[document.id];return next;});}}/><span><strong>{document.title}</strong><small>发布版本 v{document.version}</small></span>{selected[document.id]!==undefined&&<select aria-label={`${document.title}分享版本`} value={selected[document.id]} onChange={event=>{const version=Number(event.currentTarget.value);setSelected(current=>({...current,[document.id]:version}));}}>{[...new Set([document.version,...document.publishedVersions])].sort((a,b)=>b-a).map(version=><option value={version} key={version}>v{version}{version===document.version?"（当前）":""}</option>)}</select>}</label>)}{!availableDocuments.length&&<p className="muted-text">没有可管理的正式文档。</p>}</fieldset>
      <p className="room-security-help">口令不会写入分享链接；仅在此表单提交，服务端按当前文档权限核验所选版本。</p><button className="primary-button" disabled={busyId==="create"||!name.trim()||!password||!Object.keys(selected).length}>{busyId==="create"?"创建中…":"创建资料室"}</button>
    </form>}
    <div className="room-list">{rooms.map(room=><article className="room-row" key={room.id}><div className="room-row-main"><strong>{room.name}</strong><span>{room.itemCount} 篇文档 · 到期 {new Date(room.expiresAt).toLocaleString("zh-CN")}</span><small>创建于 {new Date(room.createdAt).toLocaleString("zh-CN")} · 最近访问 {room.lastAccessAt?new Date(room.lastAccessAt).toLocaleString("zh-CN"):"暂无"}</small></div><span className={`room-state ${room.revokedAt?"revoked":"active"}`}>{room.revokedAt?"已撤销":"有效"}</span><div className="room-row-actions">{!room.revokedAt&&<><button className="secondary-button compact" disabled={!!busyId} onClick={()=>void showLogs(room.id)}><Eye size={13}/>访问记录</button><button className="secondary-button compact" disabled={!!busyId} onClick={()=>void rotate(room.id)}><RotateCw size={13}/>轮换链接</button><button className="secondary-button compact danger" disabled={!!busyId} onClick={()=>void revoke(room.id)}><ShieldOff size={13}/>撤销</button></>}</div></article>)}{!rooms.length&&<div className="agent-empty"><ExternalLink size={19}/><strong>暂无外部资料室</strong><span>创建后只分享选中的正式版本。</span></div>}</div>
    {logs&&<section className="room-log-panel"><header><h3>访客访问记录</h3><button className="icon-button" aria-label="关闭访问记录" onClick={()=>setLogs(null)}>×</button></header>{logs.events.map(event=><div className="room-log-row" key={event.id}><span>{new Date(event.accessedAt).toLocaleString("zh-CN")}</span><strong>{event.outcome}</strong></div>)}{!logs.events.length&&<p className="muted-text">暂无访问记录。</p>}</section>}
  </section>;
}

/** Public-room content projection. It intentionally accepts no team/space/author or ACL metadata. */
export function ExternalRoomViewer({ documents }: { documents: Array<{ title: string; body: string }> }) {
  const safeHref = (href?: string) => { if (!href) return undefined; try { const url = new URL(href, location.origin); return ["http:","https:","mailto:"].includes(url.protocol) ? href : undefined; } catch { return undefined; } };
  return <main className="external-room-viewer"><header><span>知屿 TeamShelf</span><h1>共享资料室</h1></header>{documents.map((document,index)=><article className="external-room-document" key={`${index}-${document.title}`}><h2>{document.title}</h2><div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({href,children,...props})=>{const link=safeHref(href);return link?<a href={link} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>:<span>{children}</span>;}}}>{document.body}</ReactMarkdown></div></article>)}</main>;
}
