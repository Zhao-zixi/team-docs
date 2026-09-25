# 安全与行为测试目标

服务端角色/ACL 判定应以 Fastify `inject` 覆盖；前端补充 Markdown AST 与编辑/预览模式测试。拒绝请求须无副作用。无权资源统一 404；CSRF/非法 mutation 可返回 403/400。setup token、session token、密码不得出现在测试报告或日志。

1. **团队角色能力**：同团队 owner/admin/editor/viewer 对 team 空间和 inherit 文档执行 GET/PATCH/DELETE/改 ACL；owner/admin 全部可，editor 仅 GET/PATCH，viewer 仅 GET，其余拒绝。风险：角色越权。
2. **管理员可恢复受限资源**：owner/admin 未获 explicit grants 时仍可 GET/搜索/导出 restricted 空间及文档；普通成员按 grants 判定。风险：管理恢复失效或权限不一致。
3. **空间 grant 不提权**：团队 viewer 获空间 editor grant仍只读；团队 editor 获空间 viewer grant后只读；restricted 空间无 grant 成员 404。风险：grant 穿透团队上限。
4. **文档 grant 不能绕过空间**：restricted 文档 grant 用户若无 restricted 空间 grant仍 404；空间 editor 无文档 grant访问 restricted 文档仍 404。风险：文档授权越过空间边界。
5. **跨团队隔离**：仅属于 A 团队的用户即使知道 B 的 space/doc/revision ID，详情、修改、删除、grant 和导出均 404；响应不得包含标题/作者/正文。风险：跨租户泄露。
6. **集合元数据隔离**：A/B 与 restricted 文档混合时，树、分页、搜索、历史和统计仅含有权条目；计数、摘要和路径不得泄露无权文档。风险：元数据泄露。
7. **撤权立即生效**：editor 使用 cookie 读文档后被 admin 移出团队或撤销 space/doc grant；复用 cookie 后续 GET/PATCH/搜索立即 404 或无结果。风险：会话缓存旧授权。
8. **grant 安全**：admin 授权外团队用户，或 editor 修改 ACL，均拒绝且数据库无部分写入。风险：外部身份潜伏授权/编辑者提权。
9. **owner/admin 生命周期**：admin 任免 admin、改 owner、自我改角色及 owner 降级/删除均拒绝；合法 owner 任免 admin成功，始终恰有原 owner。风险：团队接管或无人管理。
10. **并发初始化**：空数据库上两个并发正确 setup、之后重放 token，恰有一个成功且只建一个 owner/team；错误 token 不耗尽初始化机会。风险：重复 bootstrap/权限劫持。
11. **邀请一次性与身份绑定**：7 天 token 正确接受后重放、过期、邮箱不匹配及已有账号错误密码接受均拒绝；已有账号密码 hash 不变。风险：账户接管或重复授权。
12. **乐观并发**：两个客户端读取 version N，A 更新至 N+1 后 B 使用 N PATCH 得 409；保留 A 内容/版本，响应当前版本且不回显无权内容。风险：静默覆盖。
13. **CSRF/Origin**：有效 cookie 的 mutation 缺少/错误 X-Requested-With、错误 Origin 或跨域均拒绝且数据不变；正确同源头成功。GET 不改变状态。风险：跨站操作。
14. **Markdown/XSS/无损转换**：含 script、事件属性、javascript: 链接及不支持脚注/参考链接的 Markdown，保存/读取/导出时源码按输入规范原样保留，渲染不得产生可执行 HTML/危险 href；不支持的 rich 转换阻断且不 PATCH 覆写。前端测试切换模式正文原样、复杂表格/HTML/脚注阻断、409 时保留本地草稿。风险：存储型 XSS 或静默丢稿。

部署测试须注明 Docker 是否存在。当前开发机未安装 Docker，Compose 镜像与 NAS 实机验证应在执行后如实记录，不能标为已通过。

## 本轮验证记录

- `npm run typecheck`：通过，前端与服务端 TypeScript 检查均通过。
- `npm test`：Vitest 46/46 通过，ops 3/3 通过。
- `npm run test:e2e`：Playwright 生产API端到端 1/1 通过，覆盖受限空间/文档权限、无权404、版本冲突、退出竞态和375px视口菜单。
- `npm run build`：client/server 生产构建通过；Vite提示主JS chunk约928 KB，超过500 KB建议阈值。
- 生产入口 smoke：fresh `dist/server/index.js` 服务 health 200、SPA静态文件可用；API no-store、CSP、X-Frame-Options、nosniff正确，HTTP环境未发送HSTS。
- 本机开发 smoke：隔离 DATA_DIR 下Vite页面200、setup/login、文档创建与更新/回读通过；Ctrl+C移除实例锁；同一DB重启后登录和正文回读通过。
- 文件数据库恢复集成测试：覆盖WAL在线备份、app重开、普通viewer的受限space/doc grant恢复、旧session失效和待接受邀请撤销。
- 锁测试：既有锁（含陈旧和损坏锁）拒绝自动删除；确认所有实例已停止后需手动清理。
- `npm audit`：0 vulnerabilities。
- Docker CLI不可用；未构建/启动镜像，NAS设备未实测。
