# 知屿 TeamShelf

面向团队的文档库，支持 Markdown 文档、团队空间和分层访问控制。

## 当前状态

项目正在开发中。架构、接口和安全约束见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/API.md`](docs/API.md) 与 [`docs/TESTING.md`](docs/TESTING.md)。

## 本机开发

要求 Node.js 24。复制 `.env.example` 为本地 `.env` 并设置强随机 `SETUP_TOKEN`，然后运行：

```sh
npm ci
npm run dev
```

开发前端地址为 `http://localhost:5173`，API 经 Vite 代理到 `http://localhost:3000/api`。首次初始化时使用 setup token 创建团队管理员；系统不包含默认账户。不要把 `.env`、setup token 或数据库文件提交到 Git。

常用检查：

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 部署

NAS Docker Compose 部署步骤与 SQLite 持久化/备份约束见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。SQLite 数据库必须使用容器本地 named volume，不要放在 SMB/NFS 共享目录。
