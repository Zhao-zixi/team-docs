# HTTP API 契约

所有端点使用 `/api` 前缀。请求与响应使用 UTF-8 JSON、驼峰字段；资源 ID 为 UUID，时间为 ISO 8601 字符串。成功响应遵循下文的对象包装。错误统一为 `{ "error": { "code": "CODE", "message": "说明" } }`。无权资源一律 404，不在响应、分页统计、搜索摘要或历史中泄露无权数据。所有 API 响应（含下载、搜索与历史）设置 `Cache-Control: no-store`。

认证通过 HttpOnly session cookie。所有状态变更请求（POST/PATCH/PUT/DELETE）均须发送 `X-Requested-With: TeamShelf`；若有 `Origin`，须与 `APP_ORIGIN` 精确相同。API 不开放跨域 CORS。请求体上限 500 KB。未列出的额外字段不应被静默接受。

## 共享类型

权威 TypeScript 定义见 `src/shared/types.ts`。

```ts
type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
type GrantRole = 'viewer' | 'editor';
type Visibility = 'team' | 'restricted';
type DocumentVisibility = 'inherit' | 'restricted';
interface User { id: string; email: string; name: string }
interface Team { id: string; name: string; role: TeamRole }
interface Member extends User { role: TeamRole }
interface Grant { userId: string; role: GrantRole }
interface Space {
  id: string; teamId: string; name: string; description: string;
  visibility: Visibility; canManage: boolean; canEdit: boolean
}
interface DocumentSummary {
  id: string; spaceId: string; title: string; excerpt: string;
  visibility: DocumentVisibility; version: number; updatedAt: string;
  updatedByName: string; canEdit: boolean; canManage: boolean
}
interface Document extends DocumentSummary {
  body: string; createdAt: string; createdBy: string; grants?: Grant[]
}
```

文档 `body` 是原样保存的 Markdown 字符串。版本从 1 开始。正文与标题更新必须提交当前 `version`；冲突返回 409 且不覆盖已保存内容。

## 初始化与认证

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| GET `/setup` | — | `{needsSetup: boolean}` |
| POST `/setup` | `{token,name,email,password,teamName}` | `{user,teams}`；创建首个 owner、团队和默认“团队知识库”空间，限一次 |
| POST `/auth/login` | `{email,password}` | `{user,teams}` 并设置 session cookie |
| POST `/auth/logout` | — | `{ok:true}` 并撤销当前 session |
| GET `/auth/me` | — | `{user,teams}` |
| POST `/auth/password` | `{currentPassword,newPassword}` | `{ok:true}` 并撤销所有旧 sessions |

密码长度 12–128。Setup token 必须与环境配置匹配，不向客户端返回；错误 token 不应消耗初始化机会。
## Agent 凭据

凭据管理只接受浏览器 session cookie，并继续要求 `X-Requested-With: TeamShelf`；REST 认证禁止 Bearer。创建时 `POST /agent-tokens` 接收 `{name,teamId,scope?,spaceId?,expiresInDays?}`，scope 默认 `read`、有效期默认 30 天且最大 90 天。成功只返回一次明文 `{credential,token}`；列表及后续查询仅返回 `AgentCredentialSummary` 元数据，不返回 token 或 hash。`GET /agent-tokens` 列出当前用户所有团队的凭据；owner/admin 可通过 `GET /teams/:teamId/agent-tokens` 查看本团队元数据。`DELETE /agent-tokens/:id` 撤销，权限按当前团队角色检查。scope 上限为 viewer=`read`、editor=`write`、admin/owner=`manage`；spaceId 必须属于指定团队且签发人当前可读。凭据字段见 `src/shared/types.ts`。

## 团队、成员与邀请

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| GET `/teams` | — | `{teams}` |
| POST `/teams` | `{name}` | `{team}`，创建者为 owner |
| PATCH `/teams/:teamId` | `{name}` | `{team}` |
| GET `/teams/:teamId/members` | — | `{members}` |
| PATCH `/teams/:teamId/members/:userId` | `{role}` | `{member}` |
| DELETE `/teams/:teamId/members/:userId` | — | `{ok:true}` |
| GET `/teams/:teamId/invitations` | — | `{invitations}`；不返回 token |
| POST `/teams/:teamId/invitations` | `{email,role}` | `{invitation,token}`；token 仅在此响应一次 |
| DELETE `/teams/:teamId/invitations/:id` | — | `{ok:true}` |
| GET `/invitations/:token` | — | `{teamName,email,role,expiresAt}` |
| POST `/invitations/:token/accept` | `{name?,password}` | `{user,teams}` 并建立会话 |

邀请 token 有效期 7 天，仅能使用一次，并绑定归一化邮箱。已有账号须提交正确的现有密码；绝不通过邀请重置既有账号密码。邀请当前团队成员返回 409，应通过成员管理调整角色。Owner 可管理 admin；admin 仅管理 editor/viewer，不能修改自己角色。不得改动、删除或降级当前 owner，不得退出/删除团队唯一 owner。成员删除立即撤销其团队内空间与文档 grants 及相关会话。

## 空间与授权

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| GET `/teams/:teamId/spaces` | — | `{spaces}`，按权限过滤 |
| POST `/teams/:teamId/spaces` | `{name,description?,visibility?,grants?}` | `{space}` |
| PATCH `/spaces/:spaceId` | `{name?,description?}` | `{space}` |
| GET `/spaces/:spaceId/access` | — | `{visibility,grants}` |
| PUT `/spaces/:spaceId/access` | `{visibility,grants}` | `{visibility,grants}` |
| DELETE `/spaces/:spaceId` | — | `{ok:true}`；仍有文档时 409 |

只有 owner/admin 可创建 restricted 空间、设置空间 ACL 与删除空间；editor 可在其可编辑的空间创建和修改文档。跨团队用户 grant 返回 400，写入必须原子化。`team` 空间对团队成员开放，能力仍由团队角色决定；`restricted` 空间要求显式 grant。Grant 为 viewer/editor，最终能力不得超过团队角色能力。owner/admin 对团队内所有空间有管理与恢复能力。

## 文档

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| GET `/spaces/:spaceId/documents` | — | `{documents}`，可见列表 |
| POST `/spaces/:spaceId/documents` | `{title,body?,visibility?,grants?}` | `{document}` |
| GET `/documents/:id` | — | `{document}` |
| PATCH `/documents/:id` | `{title,body,version}` | `{document}` |
| DELETE `/documents/:id` | — | `{ok:true}` |
| GET `/documents/:id/access` | — | `{visibility,grants}` |
| PUT `/documents/:id/access` | `{visibility,grants}` | `{document}` |
| GET `/documents/:id/revisions` | `{offset?,limit?,metadataOnly?}` | `{revisions,hasMore?,nextOffset?}`；PAT 默认仅元数据，不取正文 |
| GET `/documents/:id/revisions/:revisionId` | — | `{revision: Revision}`；当前文档 ACL 与 revision/document 关联同时验证 |
| POST `/documents/:id/revisions/:revisionId/restore` | `{version}` | `{document}` |
| GET `/documents/:id/export` | — | `text/markdown` 下载 |
| GET `/teams/:teamId/search?q=...` | — | `{documents}`，仅可见摘要 |
| GET `/teams/:teamId/audit` | — | `{events}`，仅 owner/admin |

`Revision` 为 `{id,version,title,body,createdAt,authorName}`。cookie 客户端历史列表未请求分页或metadataOnly时保持原行为返回正文；PAT 历史列表SQL不读取正文，需读取某一版本时调用固定单版本路径。每次内容修改与恢复均生成新版本历史快照；恢复和删除仅 owner/admin。Document ACL 仅 owner/admin 可设置；创建 restricted 文档也只允许 owner/admin。Document `inherit` 使用空间可访问能力；`restricted` 要求用户既能进入空间又有 document grant。空间权限与文档权限逐层取最小值，document grant 不得绕过 restricted 空间。`canEdit` 与 `canManage` 必须按当前请求的 ACL 计算；文档管理（ACL、删除、恢复）仅 owner/admin。所有正文、列表、搜索、历史及导出在服务端按当前 ACL 过滤，无权资源返回 404。

## 角色与分层权限摘要

| 操作者 | 团队资源 | team 空间 | restricted 空间/文档 |
|---|---|---|---|
| owner/admin | 全部读写与管理 | 全部读写与管理 | 全部读写、ACL 与恢复 |
| editor | 可读；不可管理成员/团队 ACL | 可按团队角色读写文档 | 必须逐层有 grant，且能力受团队角色限制 |
| viewer | 可读 | 只读 | 必须逐层有 viewer/editor grant，但最终仍只读 |

在任何层级授予 editor 都不能让团队 viewer 获得编辑能力；更低层级的 viewer grant 会收窄团队 editor 的编辑能力。会话只存身份标识；每个请求即时查库获取角色和 grants，以便移除成员/撤销授权立即生效。

## 统一错误

状态码至少包括：400 输入/跨团队 grant 无效，401 未认证，403 缺失 CSRF/非法 mutation，404 无权或不存在资源，409 版本冲突/重复邀请/空间非空/状态冲突，429 限速。错误消息不得包含无权资源的标题、正文、作者或存在性信息。所有失败 mutation 必须无副作用。

## Agent 与 MCP 分页

MCP 通过固定 `/mcp` endpoint 和 `Authorization: Bearer <PAT>` 连接。MCP 不接受 session cookie；Bearer 与 cookie 混合请求拒绝。PAT 的 team、space、scope 与调用人的当前团队角色、ACL 每次重新验证。管理凭据的 REST 路由只接受浏览器 session + CSRF。所有未显式标记的 REST 路由默认拒绝 Bearer。

以下列表 REST 路由支持 `offset`（默认 `0`，非负整数）与 `limit`（默认 `100`，范围 1–100），并在授权过滤后返回具体列表与 `{hasMore,nextOffset}`。适用路由：`GET /teams/:teamId/spaces`、`GET /spaces/:spaceId/documents`、`GET /teams/:teamId/search`、`GET /documents/:id/revisions`、`GET /teams/:teamId/members`、`GET /teams/:teamId/invitations`、`GET /teams/:teamId/audit`。有下一页时 `nextOffset` 为下一页起点；无下一页为 `null`。Bearer 默认页大小100，调用方可继续翻页。Cookie 客户端未传分页时保持既有行为：空间/文档/搜索/审计仍为原本最多100条，成员/邀请/历史仍返回原全量列表。带分页参数的 cookie 请求也按参数分页。

搜索接受可选 `spaceId`。服务端先验证该空间属于路径中的团队并且当前用户可读；单空间 PAT 只能指定其绑定空间。空间过滤先于文档 ACL 过滤、全文匹配与分页，跨团队或不满足绑定的空间返回 404。空间 PAT 未指定 `spaceId` 时自动仅搜索绑定空间。
