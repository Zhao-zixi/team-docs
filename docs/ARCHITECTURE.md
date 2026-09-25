# 架构

## 组件

- Node.js 24 + TypeScript + Fastify 5：同一进程提供 `/api` 与生产静态页面。
- SQLite 通过 Node 内置 `node:sqlite` 访问；数据库文件名 `teamshelf.sqlite`，位于 `DATA_DIR`。启用 WAL、外键和 busy timeout。单实例运行，数据目录需位于容器本地 named volume。
- React + Vite 提供界面；开发服务运行于 5173 并把 `/api` 代理到后端 3000。生产构建写入 `dist/client`；服务端编译写入 `dist/server`，入口为 `dist/server/index.js`。
- Tiptap v3 编辑器以 Markdown 字符串作为唯一正文；同一字符串用于保存、历史、搜索和 Markdown 导出。富文本模式转换需先验证支持的 Markdown AST，无法无损转换时阻止提交，不得静默改写正文。

## 身份与授权

团队角色为 owner、admin、editor、viewer。owner/admin 可管理团队内全部资源，包括受限资源。普通用户必须是团队成员，再由团队角色、空间可见性/授权及文档可见性/授权逐层取最小权限。`team` 空间按团队角色授权；`restricted` 空间须有空间 grant。文档默认 `inherit` 空间权限，`restricted` 文档须有文档 grant，且仍需先能进入所属空间。任何下级 grant 都不能提升团队角色能力。

每个请求即时从数据库读取会话用户、成员角色和资源 grants；不得缓存 ACL。所有列表、搜索、计数、文档、历史与导出在服务端按当前 ACL 过滤。无权资源统一返回 404，避免泄露资源存在性。删除成员时立即撤销其会话和团队内所有空间/文档 grants，避免之后重新加入时旧权限复活。

## 存储与一致性

文档正文更新采用递增 `version` 乐观锁。每次更新保存历史快照；恢复历史也必须使用调用方读到的当前版本，失败返回 409。权限更改和重要管理行为写入审计事件。初始化与邀请接受的一次性状态消费、用户/团队创建在事务中再次核对，避免并发重放。

备份使用 `node:sqlite` 的一致性 backup API，不允许直接复制活动 WAL 数据库文件。恢复前应用必须离线，并检查完整性；详见部署文档。

## 安全边界

- Setup 要求环境变量 `SETUP_TOKEN`，只允许一次成功初始化；不创建默认账户，也不向客户端下发 token。
- 密码使用带随机盐的 scrypt，长度 12–128；session cookie 随机生成、HttpOnly、SameSite=Lax，数据库仅保存 token hash，有效期 7 天。密码变化撤销全部旧 sessions。
- 每个 mutation 要求 `X-Requested-With: TeamShelf`；若请求带 Origin，必须与配置 `APP_ORIGIN` 精确匹配。开发时显式允许配置 Vite Origin；不启用任意 CORS，也不信任任意代理头。
- 请求体限制 500 KB；输入经 schema 校验。登录和邀请限速。统一 `/api` 响应设置 `Cache-Control: no-store`。
- 生产页面启用 CSP、nosniff 与 frame 防护。Markdown 按纯文本保存，预览必须安全渲染，不执行原始 HTML，不使用 `dangerouslySetInnerHTML`。日志不得包含 cookie、密码、一次性 token、邀请 URL/query 或完整请求体。

## 生产入口

生产 Fastify 服务在可配置 `PORT`（默认 3000）监听 `0.0.0.0`，提供 API 和 `dist/client`。`GET /api/health` 供健康检查。DATA_DIR 中用 `.teamshelf.lock` 单实例锁保护数据库；锁含 PID 与心跳，过期锁仅在心跳超过 120 秒时清理。SIGTERM/SIGINT 时关闭服务并释放锁。
