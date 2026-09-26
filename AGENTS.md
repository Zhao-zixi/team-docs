# 项目协作规则

遵循父目录 [`../AGENTS.md`](../AGENTS.md) 的模型分工和协作流程：Astra 负责规划与验收，Sol 负责问题分析与复核，Luna 负责实现、命令和验证。委派时选择实际可用的指定模型；不得声称执行了不可用的模型。

本项目采用 Node.js 24、TypeScript、Fastify 5、Node 内置 `node:sqlite`、React/Vite 与 Tiptap v3。Markdown 源文是唯一文档正文。共享 API 类型以 `src/shared/types.ts` 和 `docs/API.md` 为准；API 使用 `/api` 前缀、驼峰 JSON、UUID、ISO 时间，错误结构为 `{ "error": { "code": "...", "message": "..." } }`。

不得提交 `.env`、访问令牌、数据库/备份、`node_modules` 或构建产物。Git 提交必须仅在本独立仓库中按逻辑阶段暂存明确路径；勿操作父仓库索引。

## Git 工作流
- 后续项目变更必须在 codex/ 前缀分支提交，并通过 Pull Request 与 CI；不得直接推送 main。
- 相关本地验证和 PR CI 均通过且评审无阻断后，由代理按常规流程合并；不得使用 --admin 或其他方式绕过失败或未满足的检查。
