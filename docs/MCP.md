# Agent 与 MCP 设计

## 身份与凭据

MCP 使用 stateless HTTP endpoint `/mcp` 和官方 TypeScript MCP server v2.1.0 协议实现。客户端通过 `Authorization: Bearer ts_agent_…` 认证。MCP 请求不得使用浏览器 session cookie，也拒绝 Bearer 与 cookie 混合认证。若请求带 Origin，必须精确匹配 `APP_ORIGIN`；Host 仅允许配置源 hostname 或 loopback。MCP 不需要浏览器 CSRF header。

PAT 固定绑定一个用户、一个团队、一个 scope 和可选的单空间。数据库只保存 token hash、提示信息和元数据；随机 token 只在创建响应中展示一次。默认 scope 为 `read`，默认 30 天，最多 90 天。scope 不得高于签发人当前团队角色（viewer=read、editor=write、admin/owner=manage）。space-bound token 创建时必须可读该空间，此后每次调用都重新验证当前成员身份、空间存在性和 ACL。成员移除、密码更改和备份恢复会撤销该用户的 PAT。空间限定 token 永不提升为全团队 token。

凭据管理 REST API 只接受 session cookie + CSRF。用户可查看和撤销自己的凭据。owner 可查看、撤销团队所有凭据；admin 可查看团队元数据并撤销自己的以及 editor/viewer 的凭据，不能撤销 owner 或其他 admin 的凭据。已移除用户的凭据保留撤销元数据供审计。

## 工具边界

所有工具名称和 schema 固定，禁止传入任意 URL、HTTP method、actor 或 userId。路由必须由显式 route-config 白名单标记允许的 Bearer scope；未标记路由默认拒绝 Bearer。每次调用经 Fastify `app.inject` 复用 REST handler，真实用户/团队/空间来源于已校验 PAT 和数据库，仍由既有 ACL 作资源判定。写操作继续要求版本号 CAS。MCP 工具错误使用 MCP `CallToolResult` 的 `isError` 表示；成功结果使用结构化内容或文本内容。

只读工具（scope `read`）：

- `whoami {}`：返回当前用户与固定团队身份，不列出其他团队。
- `list_spaces {}`、`list_documents {spaceId}`、`search_documents {query,spaceId?}`。
- `get_document {documentId}`、`get_revisions {documentId}`、`export_document {documentId}`。

`write` 另允许 `create_document {spaceId,title,body?,visibility?}` 与 `update_document {documentId,title,body,version}`。

`manage` 另允许 `create_space {name,description?,visibility?}`、`update_space {spaceId,name?,description?}`、`delete_space {spaceId}`、`set_space_access {spaceId,visibility,grants}`、`set_document_access {documentId,visibility,grants}`、`delete_document {documentId}`、`restore_document {documentId,revisionId,version}`、`rename_team {name}`、`list_members {}`、`change_member_role {userId,role}`、`remove_member {userId}`、`list_invitations {}`、`invite_member {email,role}`、`cancel_invitation {invitationId}`、`list_audit {}`。space-bound token 禁止团队级操作。

## 存储升级

现有 v1 SQLite schema 没有迁移框架。新增凭据表时使用显式幂等迁移，兼容 `user_version=1` 数据库并升级至 v2；恢复旧备份后下次正常启动完成迁移，再撤销所有 PAT，防止旧快照复活凭据。PAT 外键不使用“空间删除后置空”语义；空间限定凭据必须保留原 spaceId 并失效/撤销，绝不能扩权。

## 审计与安全验证

调用审计保存真实 userId、credentialId、工具/操作、目标资源和结果状态，不记录 Bearer token、正文或原始邀请 token。使用官方 MCP client 通过真实 HTTP endpoint 验证协议握手和工具调用；至少覆盖默认兼容握手与自动协商新协议。工具测试还需验证 scope、团队、空间、实时 ACL、撤销、CSRF、混合凭据拒绝以及凭据恢复迁移。