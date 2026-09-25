# 知屿 TeamShelf

面向团队的文档库，支持 Markdown 文档、团队空间和分层访问控制。应用采用 Node.js 24、Fastify、SQLite 和 React；所有正文以 Markdown 源码保存。

## 本机启动

在 Windows PowerShell 中，进入项目目录并运行：

```powershell
npm ci
npm run configure
# PowerShell 窗口 1：API
npm run dev
# PowerShell 窗口 2：Vite 前端
npm run dev:client
```

`npm run configure` 会创建本地 `.env`，生成随机的一次性 `SETUP_TOKEN`，且不会覆盖现有配置。把该 token 私下输入首次初始化页面；不要提交或共享 `.env`。开发时打开两个 PowerShell 窗口：一个运行 `npm run dev` 启动 API，另一个运行 `npm run dev:client` 启动 Vite 网页（`http://localhost:5173`，API 转发到 `http://localhost:3000`）。Vite 支持前端 HMR；修改后端代码后在 API 窗口按 `Ctrl+C`，再重新运行 `npm run dev`。默认数据保存在项目目录 `data/teamshelf.sqlite`。系统不创建默认账号。

也可先运行验证：

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## NAS 部署

准备 Docker Compose v2。若 NAS 没有 Node/npm，可在项目目录用 Docker 生成本地 `.env`，随机口令只写入文件，不显示在终端：

```sh
docker run --rm -v "$PWD:/work" -w /work \
  -e APP_ORIGIN=http://192.168.1.20:8080 -e PORT=8080 \
  -e COOKIE_SECURE=false -e DATA_DIR=/app/data \
  node:24-bookworm-slim node scripts/configure.mjs
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 teamshelf
```

将 `APP_ORIGIN` 改成团队实际访问的完整地址。读取 `.env` 中的一次性 `SETUP_TOKEN` 并在首次初始化页面输入；不要提交或共享 `.env`。也可以在有 Node 24 的 Windows 管理电脑运行 `npm run configure`，再把 `.env` 复制到 NAS 部署目录。
Compose 默认将 SQLite 放在 `teamshelf-data` 命名卷中。SQLite 数据库必须留在本地容器卷，不能放到 SMB/NFS 共享目录，也不要运行多个应用实例。owner/admin 可管理并读取团队内的受限空间和文档。文档目前不支持实时协同编辑。

Docker CLI 不在本开发环境中，镜像构建、Compose 启动和 NAS 实机运行尚未验证。部署和在线备份/离线恢复细节见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 设计和接口

架构、API 与安全验证目标见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/API.md`](docs/API.md)、[`docs/TESTING.md`](docs/TESTING.md)。
