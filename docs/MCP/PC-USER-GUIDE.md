# PC 用户：用 Codex 连接 TeamShelf

本指南适用于个人 Windows 电脑上的 Codex 自定义 MCP 表单。整个过程在 PC 配置本机程序；TeamShelf 服务仍运行在 NAS 或服务器。请先从团队管理员处取得可访问的 TeamShelf 地址，再用自己的账号创建 PAT。

## 准备 PC 上的桥接程序

在 PC 安装 Node.js 24（版本范围 `>=24 <25`），并安装 Git。打开 PowerShell，在选择的本机目录中获取项目并编译：

```powershell
git clone https://github.com/Zhao-zixi/team-docs.git
Set-Location team-docs
npm.cmd ci
npm.cmd run build:server
```

构建会生成 `dist/mcp/stdio.js`。保持项目留在 PC 上；命令、参数和工作目录都填写这个 PC 上的绝对路径。不要把 NAS 的 `/vol1/...` 路径填进 Codex，也不要让 PC 上的脚本通过 `localhost` 连接远程 NAS。

## 从自己的账号取得凭据

登录 TeamShelf，打开左侧的“Agent / MCP”，创建一个自己的凭据。初次连接建议选择“只读”、绑定到实际要用的知识库，并选用默认 30 天期限。复制创建后仅显示一次的 `ts_agent_…` PAT 到密码管理器；不要把账号密码、GitHub/OpenAI 密钥或 PAT 放在 URL、截图或共享文档中。可读取内容还要满足你当前的空间访问权限。

## 在 Codex 表单逐项填写

![Codex 自定义 MCP 的空白 STDIO 配置表单](images/codex-stdio-form.png)

打开 Codex 设置中的 MCP / 自定义服务器新增表单。按表单字段填写：

| 表单字段 | 填写内容 | 从哪里取得 / 注意事项 |
| --- | --- | --- |
| 名称 | `teamshelf` 或便于识别的名称 | 本机自定义名称；建议用 `teamshelf`。 |
| 类型 | `STDIO` | 选择标准输入/输出（stdio）服务器。 |
| 启动命令 | `node.exe` 的完整 PC 本机路径，例如 `C:\Program Files\nodejs\node.exe` | 在 PowerShell 运行 `(Get-Command node).Source`，复制显示的路径；不要填 `npm`、shell 命令或 NAS 上的路径。 |
| 参数 | 项目构建产物 `dist\mcp\stdio.js` 的完整 PC 本机路径，例如 `C:\Users\you\team-docs\dist\mcp\stdio.js` | 在项目根目录运行 `(Resolve-Path .\dist\mcp\stdio.js).Path`。整条路径作为一个参数，不加 shell 引号、不拆成多行。 |
| 环境变量 | 两行：`TEAMSHELF_MCP_URL` = `https://你的NAS可达主机名/mcp`；`TEAMSHELF_MCP_TOKEN` = 你创建的 `ts_agent_…` PAT | URL 必须是 Codex 所在 PC 可访问的完整 HTTP(S) URL，并以 `/mcp` 结尾；PAT 从 TeamShelf 创建凭据时一次性复制。对外或跨网访问使用已配置 HTTPS 的地址。 |
| 环境变量传递 | 留空 | 该字段用于按名称转发 Codex 进程已经继承的环境变量。这里已在上方显式填写变量和值，不需要重复透传。若你的秘密管理器已将值注入启动 Codex 的环境，可改为只填写变量名；不要在此字段填写秘密值。 |
| 工作目录 | PC 上的项目根目录，例如 `C:\Users\you\team-docs` | 可在项目根目录运行 `(Resolve-Path .).Path` 获取。不是 `dist` 子目录，也不是 NAS 路径。 |

示例路径仅供说明，需替换为当前 PC 实际目录。`TEAMSHELF_MCP_URL` 必须指向 NAS/服务器；远程 NAS 情况下不要填 `http://localhost:...` 或 `127.0.0.1`，因为那会指向 PC 自己。PAT 只填写在这台 PC 的 Codex 环境变量值中，并保护本机配置；不要提交到项目文件。

Codex 的 STDIO 表单分别使用启动命令、参数数组、环境变量、可选的环境变量名透传和工作目录；字段含义见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 与 [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 保存并验证

保存配置后按 Codex 提示重启或刷新 MCP 连接。确认 `teamshelf` 已连接，并先调用只读 `whoami` 查看账号和团队，再调用 `list_spaces` 确认可见知识库。最后可用 `list_documents` 或 `get_document` 验证读取；不要为了排错把凭据改成管理员 token。

TeamShelf 也提供原生 Streamable HTTP MCP `/mcp`，Codex 若使用 HTTP 类型连接，可填同一 NAS URL 并按客户端的安全方式提供 Bearer PAT；这是可选路径，不改变下面错误排查中的地址与权限要求。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| MCP 进程无法启动 / 找不到文件 | 确认 Node 24 已安装；“启动命令”是 PC 的 `node.exe` 绝对路径；参数指向已成功生成的 `dist\mcp\stdio.js`；工作目录是 PC 项目根。 |
| 连接超时、DNS 或 TLS 错误 | 确认 PC 能访问 NAS 地址与端口，证书受信任，反向代理转发 `/mcp`。远程 NAS 不可用 PC 的 localhost。 |
| 404 或 endpoint 无效 | `TEAMSHELF_MCP_URL` 应为完整的 HTTP(S) 地址并以 `/mcp` 结尾，不要填网页首页。 |
| 401 未授权 | 检查 PAT 是否复制完整、未过期/撤销，以及 `TEAMSHELF_MCP_TOKEN` 是否填写在环境变量表中。修改后重新保存并刷新连接。 |
| 403 或工具调用失败 | 检查 token 的 scope、绑定知识库和创建者当前角色/空间 ACL。客户端可能仍会列出工具名称，但越权调用会被服务端拒绝；空间范围之外的数据不会显示。 |
| 列表或工具没有更新 | 检查 Codex 中服务器名称和配置字段，保存后重启/刷新客户端，再查看连接状态。 |
