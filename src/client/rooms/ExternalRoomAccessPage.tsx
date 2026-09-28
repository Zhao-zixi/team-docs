import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api";
import { ExternalRoomViewer } from "./ExternalRoomManager";

type PublicDocument = { title: string; body: string };
export function ExternalRoomAccessPage({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [documents, setDocuments] = useState<PublicDocument[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  useEffect(() => { setPassword(""); setDocuments(null); setError(""); setExpired(false); }, [token]);
  async function enter(event: React.FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    const submittedPassword = password;
    setPassword(""); setBusy(true); setError("");
    try {
      await api.post(`/share/${encodeURIComponent(token)}/session`, { password: submittedPassword });
      const result = await api.get<{ documents: PublicDocument[] }>(`/share/${encodeURIComponent(token)}/items`);
      setDocuments(result.documents);
    } catch {
      setError("无法打开资料室。请检查口令、链接有效期，或联系分享者。链接和口令不会保存在此页面。");
      setExpired(true);
    } finally { setBusy(false); }
  }
  if (documents) return <ExternalRoomViewer documents={documents}/>;
  return <main className="external-room-gate"><form className="external-room-gate-card" onSubmit={enter}>
    <div className="room-gate-icon"><KeyRound size={22}/></div><span className="eyebrow">知屿 TeamShelf</span><h1>打开共享资料室</h1>
    <p>输入分享者提供的独立口令。资料室只显示被选中的正式文档。</p>
    <label className="field"><span>资料室口令</span><input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.currentTarget.value)} required disabled={busy||expired}/></label>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {expired&&<button className="secondary-button" type="button" onClick={()=>{setExpired(false);setError("");}}>重新输入口令</button>}
    <button className="primary-button full" disabled={busy||expired||!password}>{busy?"正在验证…":"进入资料室"}</button>
  </form></main>;
}