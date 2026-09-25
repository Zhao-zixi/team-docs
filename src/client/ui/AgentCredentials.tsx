import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, Shield, Trash2 } from "lucide-react";
import { api, ApiError } from "../api";
import type { AgentCredentialSummary, AgentScope, Space, Team, User } from "../../shared/types";

type Props = { team: Team; user: User; spaces: Space[]; close: () => void; onAuthError: (error: unknown) => void };
const scopeText: Record<AgentScope, string> = { read: "只读", write: "读写", manage: "管理" };
const scopeLimit = (role: Team["role"]): AgentScope => role === "owner" || role === "admin" ? "manage" : role === "editor" ? "write" : "read";
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "从未使用";

export function AgentCredentials({ team, user, spaces, close, onAuthError }: Props) {
  const targetKey = `${user.id}:${team.id}`;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const requestGeneration = useRef(0);
  const [own, setOwn] = useState<AgentCredentialSummary[]>([]);
  const [teamCredentials, setTeamCredentials] = useState<AgentCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AgentScope>("read");
  const [spaceId, setSpaceId] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const admin = team.role === "owner" || team.role === "admin";
  const targetIsCurrent = (generation: number) => generation === requestGeneration.current && targetRef.current === targetKey;

  async function reload() {
    const generation = ++requestGeneration.current;
    const capturedTarget = targetKey;
    setLoading(true);
    setError("");
    try {
      const [mine, all] = await Promise.all([
        api.get<{ credentials: AgentCredentialSummary[] }>("/agent-tokens"),
        admin ? api.get<{ credentials: AgentCredentialSummary[] }>(`/teams/${encodeURIComponent(team.id)}/agent-tokens`) : Promise.resolve({ credentials: [] as AgentCredentialSummary[] }),
      ]);
      if (!targetIsCurrent(generation) || capturedTarget !== targetRef.current) return;
      setOwn(mine.credentials.filter(credential => credential.teamId === team.id));
      setTeamCredentials(all.credentials.filter(credential => credential.teamId === team.id));
    } catch (cause) {
      if (!targetIsCurrent(generation)) return;
      setSecret(null);
      setCopied(false);
      setError(cause instanceof Error ? cause.message : "无法加载凭据。请稍后重试。");
      if (cause instanceof ApiError && cause.status === 401) onAuthError(cause);
    } finally {
      if (targetIsCurrent(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    return () => { requestGeneration.current++; };
    // Panel is keyed by the immutable team/user pair in App; reload is intentionally mount-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSecret = () => { setSecret(null); setCopied(false); };
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (loading || busy || !name.trim() || name.trim().length > 80) return;
    clearSecret();
    setError("");
    setBusy(true);
    const capturedTarget = targetKey;
    const generation = requestGeneration.current;
    try {
      const result = await api.post<{ credential: AgentCredentialSummary; token: string }>("/agent-tokens", {
        name: name.trim(), teamId: team.id, scope, ...(spaceId ? { spaceId } : {}), expiresInDays,
      });
      if (!targetIsCurrent(generation) || targetRef.current !== capturedTarget) return;
      setSecret(result.token);
      setCopied(false);
      setOwn(current => [result.credential, ...current.filter(credential => credential.id !== result.credential.id)]);
      if (admin) setTeamCredentials(current => [result.credential, ...current.filter(credential => credential.id !== result.credential.id)]);
      setName("");
    } catch (cause) {
      if (!targetIsCurrent(generation)) return;
      clearSecret();
      setError(cause instanceof Error ? cause.message : "创建凭据失败，请重试。");
      if (cause instanceof ApiError && cause.status === 401) onAuthError(cause);
    } finally {
      if (targetIsCurrent(generation)) setBusy(false);
    }
  }

  async function revoke(credential: AgentCredentialSummary) {
    if (loading || busy || !credential.canRevoke) return;
    if (!window.confirm(`撤销「${credential.name}」？使用此凭据的 Agent 将立即无法继续访问。`)) return;
    clearSecret();
    setError("");
    setBusy(true);
    const capturedTarget = targetKey;
    const generation = requestGeneration.current;
    try {
      await api.delete(`/agent-tokens/${encodeURIComponent(credential.id)}`);
      if (!targetIsCurrent(generation) || targetRef.current !== capturedTarget) return;
      setOwn(current => current.filter(item => item.id !== credential.id));
      setTeamCredentials(current => current.filter(item => item.id !== credential.id));
    } catch (cause) {
      if (!targetIsCurrent(generation)) return;
      clearSecret();
      setError(cause instanceof Error ? cause.message : "撤销凭据失败，请重试。");
      if (cause instanceof ApiError && cause.status === 401) onAuthError(cause);
    } finally {
      if (targetIsCurrent(generation)) setBusy(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); setCopied(true); }
    catch { setError("复制未成功。请在下方密钥框中选择文本并手动复制。"); }
  }

  const maxScope = scopeLimit(team.role);
  const busyControls = loading || busy;
  const credentialRow = (credential: AgentCredentialSummary, showOwner: boolean) => {
    const revoked = !!credential.revokedAt;
    const expired = Date.parse(credential.expiresAt) <= Date.now();
    const status = revoked ? "已撤销" : expired ? "已过期" : "有效";
    return <div className="agent-token-row" key={credential.id}>
      <div className="agent-token-main">
        <div className="agent-token-title"><strong>{credential.name}</strong><span className={`agent-state ${revoked || expired ? "inactive" : "active"}`}>{status}</span></div>
        <span>{showOwner ? `${credential.userName} · ` : ""}{scopeText[credential.scope]} · {credential.spaceName || (credential.spaceId ? spaces.find(item => item.id === credential.spaceId)?.name : null) || "整个团队"}</span>
        <small>创建于 {formatDate(credential.createdAt)} · 到期 {formatDate(credential.expiresAt)} · 最近使用 {formatDate(credential.lastUsedAt)}</small>
        <code>提示：{credential.tokenHint}</code>
      </div>
      {credential.canRevoke && <button type="button" className="icon-button danger" aria-label={`撤销${credential.name}`} disabled={busyControls} onClick={() => void revoke(credential)}><Trash2 size={15}/></button>}
    </div>;
  };

  return <div className="agent-panel">
    <div className="agent-intro"><div className="agent-intro-icon"><KeyRound size={18}/></div><div><strong>为 Agent 创建独立凭据</strong><p>凭据固定属于当前团队和你的账号。Agent 权限受此凭据范围与当前成员权限共同限制；管理员现有的团队管理权限仍按服务端策略生效。</p></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {secret && <section className="agent-secret" aria-label="一次性凭据">
      <div className="agent-secret-head"><strong><Shield size={15}/>请立即复制此密钥</strong><span>关闭此窗口后将无法再次查看</span></div>
      <label className="field"><span>Agent Token（仅显示这一次）</span><input aria-label="一次性 Agent Token" readOnly autoComplete="off" spellCheck={false} value={secret} onFocus={event => event.currentTarget.select()}/></label>
      <div className="agent-secret-actions"><button type="button" className="secondary-button" onClick={() => void copySecret()}><Copy size={15}/>{copied ? "已复制" : "复制密钥"}</button><button type="button" className="text-button" onClick={clearSecret}>我已保存，隐藏密钥</button></div>
      <p>不要把密钥粘贴到文档、截图、URL 或可共享的配置文件中。建议保存在密码管理器或部署平台的 Secret 中。</p>
    </section>}
    <form className="stack-form agent-create-form" onSubmit={event => void create(event)}>
      <h3>新建凭据</h3>
      <FieldLike label="名称"><input aria-label="凭据名称" required minLength={1} maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：知识库只读助手" disabled={busyControls}/></FieldLike>
      <div className="agent-form-grid">
        <FieldLike label="权限范围"><select aria-label="Agent 权限范围" value={scope} onChange={event => setScope(event.target.value as AgentScope)} disabled={busyControls}>{(["read", "write", "manage"] as AgentScope[]).map(value => <option key={value} value={value} disabled={(["read", "write", "manage"] as AgentScope[]).indexOf(value) > (["read", "write", "manage"] as AgentScope[]).indexOf(maxScope)}>{scopeText[value]}{value === maxScope ? "（当前上限）" : ""}</option>)}</select></FieldLike>
        <FieldLike label="知识库范围"><select aria-label="限制知识库" value={spaceId} onChange={event => setSpaceId(event.target.value)} disabled={busyControls}><option value="">整个团队（按成员权限）</option>{spaces.filter(item => item.teamId === team.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FieldLike>
      </div>
      <FieldLike label="有效期"><select aria-label="凭据有效期" value={expiresInDays} onChange={event => setExpiresInDays(Number(event.target.value))} disabled={busyControls}><option value={7}>7 天</option><option value={30}>30 天（默认）</option><option value={90}>90 天</option></select></FieldLike>
      <button type="submit" className="primary-button full" disabled={busyControls || !name.trim()}>{busy ? "处理中…" : loading ? "加载凭据中…" : "创建并显示一次性密钥"}</button>
    </form>
    <section className="agent-help"><strong>连接说明</strong><p>TeamShelf 提供无状态 MCP HTTP 端点 <code>/mcp</code>。将下面的占位符替换为实际地址和密钥，并把密钥存入客户端的 Secret 配置；请求使用 Bearer Token，不要同时携带知屿网页登录 Cookie。</p><pre><code>{`Authorization: Bearer YOUR_AGENT_TOKEN\nPOST https://YOUR_TEAM_SHELF_HOST/mcp`}</code></pre><p>只读范围可搜索和阅读授权内容；读写范围还可创建、修改文档；管理范围额外开放团队管理工具。单知识库凭据不能执行团队级管理操作。调整你的团队角色或内容访问权限，也会相应限制 Agent 能力。</p><p>需要 stdio 客户端时，可使用项目自带的本地转接器；它只连接上面的 HTTP MCP 地址：</p><pre><code>{`TEAMSHELF_MCP_URL=https://YOUR_TEAM_SHELF_HOST/mcp`}{"\\n"}{`TEAMSHELF_MCP_TOKEN=YOUR_AGENT_TOKEN`}{"\\n"}{`node C:/path/to/teamshelf/dist/mcp/stdio.js`}</code></pre></section>
    <section className="agent-list-section"><div className="agent-section-title"><div><h3>我创建的凭据</h3><p>仅显示当前团队的凭据；密钥不会再次返回。</p></div><button type="button" className="icon-button" aria-label="刷新我的凭据" title="刷新" disabled={busyControls} onClick={() => void reload()}><RefreshCw size={15}/></button></div>
      {loading ? <div className="agent-loading" role="status">正在读取凭据列表…</div> : own.length ? <div className="agent-token-list">{own.map(item => credentialRow(item, false))}</div> : <div className="agent-empty"><KeyRound size={18}/><strong>还没有凭据</strong><span>为此团队创建的凭据会列在这里。</span></div>}
    </section>
    {admin && <section className="agent-list-section team-agent-list"><div className="agent-section-title"><div><h3>团队凭据</h3><p>仅团队管理者可见元数据，密钥始终不可查看。</p></div></div>
      {loading ? <div className="agent-loading">正在读取团队凭据…</div> : teamCredentials.length ? <div className="agent-token-list">{teamCredentials.map(item => credentialRow(item, true))}</div> : <div className="agent-empty"><strong>暂无团队凭据</strong><span>成员创建凭据后会显示在这里。</span></div>}
    </section>}
    <div className="agent-footer"><span>当前团队：{team.name} · 创建者：{user.name}</span><button type="button" className="secondary-button" onClick={() => { clearSecret(); close(); }}>关闭</button></div>
  </div>;
}

function FieldLike({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function AgentCredentialsDialog({ open, team, user, spaces, close, onAuthError }: { open: boolean; team: Team | null; user: User | null; spaces: Space[]; close: () => void; onAuthError: (error: unknown) => void }) {
  if (!open || !team || !user) return null;
  return <div className="modal-scrim agent-modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal-card agent-modal-card" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
      <header className="modal-head"><div><span className="eyebrow">集成与自动化</span><h2 id="agent-modal-title">Agent / MCP 凭据</h2></div><button type="button" className="icon-button" aria-label="关闭 Agent / MCP" onClick={close}><span aria-hidden="true">×</span></button></header>
      <div className="modal-body"><AgentCredentials key={`${user.id}:${team.id}`} team={team} user={user} spaces={spaces} close={close} onAuthError={onAuthError}/></div>
    </section>
  </div>;
}