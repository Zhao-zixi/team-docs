import type { User } from "../../shared/types";

type Props = { user: User; close: () => void };

/** Shows connection values only; the user's password is entered on their own PC. */
export function McpConnection({ user, close }: Props) {
  const endpoint = `${window.location.origin}/mcp`;
  const template = `TEAMSHELF_MCP_URL=${endpoint}\nTEAMSHELF_MCP_EMAIL=${user.email}\nTEAMSHELF_MCP_PASSWORD=<网页登录密码>`;

  return <div className="mcp-connection-panel">
    <div className="mcp-connection-intro">
      <strong>用你的知屿账号连接 MCP</strong>
      <p>在你自己的电脑上，把网页登录邮箱和密码配置到 MCP 客户端。不要在此页面或共享文档中填写、粘贴或保存密码。</p>
    </div>
    <section className="mcp-connection-values" aria-label="MCP 连接配置">
      <div><span>服务地址</span><code>{endpoint}</code></div>
      <div><span>登录邮箱</span><code>{user.email}</code></div>
      <div><span>网页登录密码</span><span className="mcp-password-hint">在你自己的电脑配置；此处不会读取或显示</span></div>
    </section>
    <section className="mcp-connection-help">
      <strong>客户端环境变量名称</strong>
      <p>在 Codex 的本地 MCP 配置中填写以下三个字段。密码只在你自己的电脑上填写，不要把真实密码放入 URL、代码库或截图。</p>
      <pre><code>{template}</code></pre>
      <p>MCP 本身没有独立到期日；登录邮箱和密码有效且当前团队角色、知识库和文档权限允许时才能使用。TeamShelf 每次操作都会重新认证并检查最新权限。改密、移出团队或调整权限后，下次操作即按最新状态处理。修改密码后，请更新本机环境变量并重启 MCP 客户端。</p>
      <p>如果账号属于多个团队，Agent 先调用 <code>list_teams</code> 并在团队级操作中选择团队；读取或修改文档时，服务端会从文档本身确定团队并再次检查访问权限。</p>
    </section>
    <div className="mcp-connection-footer"><span>此连接使用你的现有成员账号，不创建额外密钥。</span><button type="button" className="secondary-button" onClick={close}>关闭</button></div>
  </div>;
}

export function McpConnectionDialog({ open, user, close }: { open: boolean; user: User | null; close: () => void }) {
  if (!open || !user) return null;
  return <div className="modal-scrim mcp-connection-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal-card mcp-connection-card" role="dialog" aria-modal="true" aria-labelledby="mcp-connection-title">
      <header className="modal-head"><div><span className="eyebrow">集成与自动化</span><h2 id="mcp-connection-title">MCP 连接</h2></div><button type="button" className="icon-button" aria-label="关闭 MCP 连接" onClick={close}><span aria-hidden="true">×</span></button></header>
      <div className="modal-body"><McpConnection user={user} close={close}/></div>
    </section>
  </div>;
}
