# 开发计划

每个逻辑阶段独立验证并在本仓库提交明确文件。前端与部署可并行开发不冲突的路径；共享契约变更先协调。

1. 脚手架与契约：初始化独立仓库、锁定依赖、共享类型、架构/API/安全测试文档。
2. 数据层与身份：SQLite schema/migrations/事务、setup/login/logout/password、会话 cookie、一次性邀请与团队成员操作。
3. ACL 与空间/文档：即时授权判定、空间/grants、Markdown 文档、版本历史/恢复、搜索/导出/审计、备份和锁生命周期。
4. 前端：认证/setup、团队与成员、空间授权、文档 Markdown/富文本双模式、搜索/历史和冲突处理。
5. 部署：多阶段 Node 24 镜像、Compose named volume、配置和安全运行约束、备份/恢复。
6. 验证与修复：Fastify inject/Vitest、TypeScript 检查、构建、浏览器 E2E、生产入口烟测；NAS/Docker 未可用时明确记录限制。

## 验收门槛

- 所有 API 都实现服务端 ACL，跨团队/无权对象返回 404 且无元数据泄漏。
- mutation 具备 CSRF/Origin 约束、输入校验与无副作用失败行为。
- Markdown 源字符串唯一、版本冲突不覆盖、历史和审计按当前 ACL 过滤。
- `npm run typecheck`、`npm test`、`npm run build` 通过；浏览器 E2E 与生产入口 smoke 明确记录结果。
- Compose 与数据持久化按 `docs/DEPLOYMENT.md` 验证；没有实际运行的验证不得声称通过。
