# Agent 与 MCP

TeamShelf 为 MCP 客户端提供固定 `/mcp` endpoint。浏览器用户和 MCP 客户端使用同一知屿账号身份，MCP 连接配置为服务 URL、登录邮箱和网页登录密码；TeamShelf 在每次 MCP 请求中重新认证，并以当前团队成员角色、知识库权限和文档 ACL 授权。MCP 不创建或签发 PAT、API key 或 session。

## 用户配置

- PC 上用 Codex 的详细步骤见[PC 用户指南](MCP/PC-USER-GUIDE.md)，管理员配置与权限管理见[管理员指南](MCP/ADMIN-GUIDE.md)。
- 新手推荐 Codex STDIO 桥。必须在 PC 安装 Node.js `>=24 <25`，运行 `npm.cmd ci`、`npm.cmd run build:server`，在客户端使用该 PC 的 `node.exe`、`dist/mcp/stdio.js` 绝对路径和本机项目工作目录。
- 三个进程环境变量为 `TEAMSHELF_MCP_URL`（完整 HTTP(S) `/mcp` URL）、`TEAMSHELF_MCP_EMAIL`（知屿登录邮箱）、`TEAMSHELF_MCP_PASSWORD`（知屿网页登录密码）。本地示例不代表客户端会加密保存环境变量；只在可信个人电脑中配置密码。
- TeamShelf 同时提供 Streamable HTTP MCP；客户端需支持 HTTP Basic 账号认证。本文不推测未经官方客户端文档证实的 Codex HTTP 表单字段。

MCP 本身没有独立到期日；登录邮箱和密码有效且当前团队角色、空间和文档 ACL 允许时才能使用。每次调用都会重新验证账号密码和最新权限。改密、移出团队或调整 ACL 后，下次请求立刻按新状态认证和授权；权限变化不需重配连接。网页登录密码更改后，使用者需更新本机 `TEAMSHELF_MCP_PASSWORD` 并重启 MCP 子进程。

旧 `TEAMSHELF_MCP_TOKEN` 和 PAT 认证已停用。迁移时保留 `TEAMSHELF_MCP_URL`，替换为自己的 `TEAMSHELF_MCP_EMAIL` 与 `TEAMSHELF_MCP_PASSWORD`。无需额外 PAT、专用账号或密钥。详见[PC 用户指南](MCP/PC-USER-GUIDE.md)。

## 团队与授权

`whoami` 返回当前登录账号身份；`list_teams` 列出此账号当前所属团队。单团队账号可直接使用；团队级工具对多团队账号要求由调用方明确指定 `teamId`。文档、知识库等资源级操作以资源 ID 从服务端查找所属团队，并重新检查当前成员与 ACL。客户端提交的团队 ID 不能替代或扩大资源权限。

MCP 调用沿用网页授权规则：viewer 可读授权内容，editor 在当前角色和资源权限允许时可编辑，owner/admin 保留既有团队管理能力。管理角色并不自动授予越过受限知识库或文档规则的能力。拒绝访问的资源按服务端规则返回未找到或 MCP 工具错误；MCP 不缓存旧的成员或 ACL 权限。

所有工具名和 schema 都固定；客户端不能指定任意 URL、HTTP method 或自报 actor。工具包含身份、团队、空间、文档、搜索与历史等功能，写入操作还执行版本检查；管理类工具遵循对应的 owner/admin 约束。实际工具列表可通过 MCP `tools/list` 查询，需结合当前团队角色和资源权限判断是否可执行。

## HTTP 和本地 STDIO 桥

原生 HTTP endpoint 为服务主机上的 `/mcp`，使用 HTTP Basic 认证，用户名为知屿登录邮箱、密码为网页登录密码。通过公网连接应使用 HTTPS，并确保反向代理把 `/mcp` 请求转发到 TeamShelf。不要把密码放进 URL、命令参数或共享配置文件。

官方 MCP STDIO 桥把本机 Codex 的 JSON-RPC 输入转发到 TeamShelf HTTP MCP 服务。它只需从客户端子进程继承以上三个环境变量，不访问浏览器会话或数据库。PC 与 TeamShelf 部署机可以不同；PC 上的 Node、脚本参数和工作目录必须使用 PC 路径，NAS 的文件路径不会在 PC 上生效。

## 验证和排错

先调用 `whoami` 和 `list_teams` 检查账号与团队，再调用 `list_spaces`、`list_documents` 或 `get_document` 验证当前可见资源。多团队操作先选目标团队。

| 现象 | 检查 |
| --- | --- |
| 连接超时、404 或 TLS 错误 | 检查 PC 可达的 HTTP(S) 地址、`/mcp` 路径、反向代理与证书；远程 PC 不能连接 NAS 的 localhost。 |
| 认证失败 | 确认三个环境变量名称和值正确，登录邮箱和最新网页登录密码匹配；若刚改过密码，更新本机配置并重启 MCP 子进程。 |
| 返回 429 | 核对邮箱和密码，按响应 `Retry-After` 提示等待后重试；不要连续反复保存或启动。 |
| 工具找不到预期团队/文档 | 调用 `list_teams`，选择正确团队，并在网页检查账号当前成员身份、知识库权限和文档 ACL。 |
| 角色/ACL 调整后的结果不符合预期 | 每个请求都会使用最新授权。确认改动针对 MCP 登录的邮箱和正确资源，随后重新调用工具。无需重配客户端。 |

配置字段和客户端能力请查阅[官方 Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)与[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
