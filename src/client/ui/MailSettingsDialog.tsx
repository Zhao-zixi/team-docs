import { useEffect, useState } from "react";
import { Mail, Send, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { User } from "../../shared/types";

type MailSettings = {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  fromEmail: string;
  fromName: string;
  hasPassword: boolean;
};
type Draft = Omit<MailSettings, "hasPassword"> & { password: string };
type SavedConnection = Pick<MailSettings, "host" | "port" | "security" | "username">;
const emptyDraft = (): Draft => ({ host: "", port: 587, security: "starttls", username: "", fromEmail: "", fromName: "", password: "" });

export function MailSettingsDialog({ open, user, close, onAuthError }: { open: boolean; user: User; close: () => void; onAuthError: (error: unknown) => void }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [hasPassword, setHasPassword] = useState(false);
  const [savedConnection, setSavedConnection] = useState<SavedConnection | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const connectionChanged = !!hasPassword && !!savedConnection && (draft.host !== savedConnection.host || draft.port !== savedConnection.port || draft.security !== savedConnection.security || draft.username !== savedConnection.username);
  const passwordRequired = !hasPassword || connectionChanged;

  useEffect(() => {
    if (!open) return;
    let active = true;
    api.get<{ configured: boolean; settings: MailSettings | null }>("/mail/settings").then(result => {
      if (!active) return;
      setConfigured(result.configured);
      if (result.settings) {
        const { hasPassword: passwordPresent, ...settings } = result.settings;
        setDraft({ ...settings, password: "" });
        setHasPassword(passwordPresent);
      }
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) onAuthError(reason);
      else setError(reason instanceof Error ? reason.message : "无法读取邮箱设置。");
    }).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [open, onAuthError]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    if (passwordRequired && !draft.password) { setBusy(false); setError("SMTP连接设置已更改，请重新输入授权码。"); return; }
    try {
      const { password, ...settings } = draft;
      const result = await api.put<{ configured: boolean; settings: MailSettings }>("/mail/settings", { ...settings, ...(password ? { password } : {}) });
      setConfigured(result.configured); setHasPassword(result.settings.hasPassword); setSavedConnection({ host: result.settings.host, port: result.settings.port, security: result.settings.security, username: result.settings.username }); setDraft(current => ({ ...current, password: "" }));
      setMessage("发信邮箱设置已保存。授权码不会再次显示；连接参数不变时留空可保留已存授权码。");
    } catch (reason) {
      setDraft(current => ({ ...current, password: "" }));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) onAuthError(reason);
      else setError(reason instanceof Error ? reason.message : "保存失败，请检查设置后重试。");
    } finally { setBusy(false); }
  }

  async function testMail() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api.post<{ sent: boolean; to: string; error?: string }>("/mail/settings/test", {});
      if (!result.sent) { setDraft(current => ({ ...current, password: "" })); setError(result.error ?? "测试邮件发送失败，请检查配置。"); return; }
      setDraft(current => ({ ...current, password: "" })); setMessage("测试邮件已发送至 " + result.to + "。");
    } catch (reason) {
      setDraft(current => ({ ...current, password: "" }));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) onAuthError(reason);
      else setError(reason instanceof Error ? reason.message : "测试邮件发送失败，请检查设置和服务器日志。");
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("删除个人发信邮箱设置？现有邀请仍有效，但之后需要重新配置才能发信。")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await api.delete("/mail/settings"); setConfigured(false); setHasPassword(false); setSavedConnection(null); setDraft(emptyDraft());
      setMessage("发信邮箱设置已删除。");
    } catch (reason) {
      setDraft(current => ({ ...current, password: "" }));
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) onAuthError(reason);
      else setError(reason instanceof Error ? reason.message : "删除失败，请重试。");
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return <div className="modal-scrim mail-settings-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal-card mail-settings-card" role="dialog" aria-modal="true" aria-labelledby="mail-settings-title">
      <header className="modal-head"><div><span className="eyebrow">个人发信邮箱</span><h2 id="mail-settings-title">邮箱与邀请</h2></div><button className="icon-button" aria-label="关闭对话框" onClick={close}><X/></button></header>
      <div className="modal-body mail-settings-body">
        {error && <div className="form-error" role="alert">{error}</div>}
        {message && <div className="inline-note" role="status">{message}</div>}
        <div className="inline-note"><Mail size={15}/><span>邮件邀请由你配置的邮箱发送。测试邮件只发到当前登录邮箱 <strong>{user.email}</strong>。授权码仅写入服务器，保存后不会回显。</span></div>
        {loading ? <div className="empty-state" aria-live="polite">正在读取邮箱设置…</div> : <form className="stack-form" onSubmit={event => void save(event)}>
          <div className="mail-settings-grid">
            <label className="field"><span>SMTP 主机</span><input required maxLength={253} autoComplete="off" value={draft.host} onChange={event => update("host", event.target.value)} placeholder="smtp.example.com"/></label>
            <label className="field"><span>端口</span><input required type="number" min={1} max={65535} value={draft.port} onChange={event => update("port", Number(event.target.value))}/></label>
          </div>
          <div className="mail-settings-grid">
            <label className="field"><span>连接加密</span><select value={draft.security} onChange={event => update("security", event.target.value as Draft["security"])}><option value="starttls">STARTTLS（常见端口 587）</option><option value="tls">隐式 TLS（常见端口 465）</option></select></label>
            <label className="field"><span>SMTP 用户名</span><input required maxLength={254} autoComplete="username" value={draft.username} onChange={event => update("username", event.target.value)}/></label>
          </div>
          <div className="mail-settings-grid">
            <label className="field"><span>发件邮箱</span><input required type="email" maxLength={254} autoComplete="email" value={draft.fromEmail} onChange={event => update("fromEmail", event.target.value)}/></label>
            <label className="field"><span>发件人名称</span><input required maxLength={100} value={draft.fromName} onChange={event => update("fromName", event.target.value)}/></label>
          </div>
          <label className="field"><span>SMTP 授权码{hasPassword ? (connectionChanged ? "（连接参数已更改，请重新输入）" : "（已保存；留空保持不变）") : ""}</span><input type="password" autoComplete="new-password" value={draft.password} onChange={event => update("password", event.target.value)} placeholder={connectionChanged ? "连接设置变更，请重新输入" : hasPassword ? "已配置，不会回显" : "输入邮箱服务商提供的授权码"} required={passwordRequired}/></label>{connectionChanged&&<div className="form-error" role="status">SMTP主机、端口、加密方式或用户名已更改，请重新输入授权码后保存。</div>}
          <div className="inline-note">{configured ? "设置已配置。测试邮件使用已保存设置并发至上方显示的登录邮箱；未保存的授权码不会用于测试。" : "配置保存前不会发送邮件。请使用邮箱服务商提供的 SMTP 授权码。"}</div>
          <div className="mail-settings-actions"><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存邮箱设置"}</button><button className="secondary-button" type="button" disabled={busy || !configured} onClick={() => void testMail()}><Send size={15}/>{busy ? "处理中…" : "发送测试邮件"}</button>{configured && <button className="secondary-button danger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/>删除设置</button>}</div>
        </form>}
      </div>
    </section>
  </div>;
}
