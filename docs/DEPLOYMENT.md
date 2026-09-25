# TeamShelf 部署与运维

TeamShelf 由 Node.js 24 LTS 提供同源 API 和网页，数据保存在 `DATA_DIR/teamshelf.sqlite`。服务按单实例运行，SQLite 文件应放在 NAS 的本地 Docker 命名卷中。不要把数据库放到 SMB/NFS 共享目录，也不要启动多个应用副本。

## 本机启动

需要 Node.js 24 和 npm。在项目目录运行：

```sh
npm ci
npm run configure
npm run dev
```

`npm run configure` 创建项目根目录 `.env`，默认 origin 为 `http://localhost:8080`、端口为 `8080`。开发脚本会把本地 Vite origin/服务端口设为 `http://localhost:5173` 和 `3000`，并从 `.env` 读取初始化 token 和数据目录。首次打开时按页面提示使用一次性 setup token 完成初始化；token 存在 `.env`，在本机读取后输入即可。已存在 `.env` 时命令拒绝覆盖；确定要重新生成时运行 `npm run configure -- --force`。

部署到 NAS 前，将 `APP_ORIGIN` 改成用户实际访问的完整 origin，包括协议、域名或 IP 和端口，例如 `http://192.168.1.20:8080`。origin 必须与浏览器地址精确一致。`DATA_DIR` 默认 `./data`，开发数据在项目目录下。

NAS 没有 Node.js 时，不需要在 NAS 安装 Node。可以在有 Node 24 的管理电脑上运行 configure，然后把项目和 `.env` 放到 NAS 的部署目录；或者用 Docker 生成 token：

```sh
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

将输出值粘贴到 NAS 部署目录 `.env` 的 `SETUP_TOKEN=` 后面。不要将 token 放进命令历史、截图或共享日志。

## Docker Compose 部署

安装并启用 NAS 厂商提供的 Docker/Container Manager。项目目录内复制 `.env.example` 为 `.env`，生成强随机 `SETUP_TOKEN`，并设置 NAS 上浏览器访问的精确 `APP_ORIGIN`。HTTP 局域网示例：

```dotenv
PORT=8080
APP_ORIGIN=http://192.168.1.20:8080
COOKIE_SECURE=false
SETUP_TOKEN=<随机生成的值>
```

在项目目录运行：

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 teamshelf
```

浏览器打开 `http://192.168.1.20:8080`。容器健康检查请求 `GET /api/health`；可查看 `docker compose ps` 状态确认服务健康。Compose 默认创建 `teamshelf-data` 命名卷，并把它挂载到 `/app/data`。该卷随容器重建保留。

Synology DSM 可在 Container Manager 的“项目”中选择项目目录并从 `compose.yaml` 构建启动。QNAP Container Station 的 Compose/应用功能可导入同一项目文件。若厂商界面无法构建项目，可在管理电脑运行 `docker compose build` 并将镜像导入 NAS；Compose 文件仍需在 NAS 上配置卷和环境变量。NAS CPU 常见为 amd64 或 arm64；Dockerfile 使用 Node 官方多架构基础镜像，但本项目未在本机验证 arm64 镜像构建。

通过 HTTPS 反向代理时，代理应将原始 Host 与 HTTPS 转发给容器，并仅对用户开放代理入口。设置 `APP_ORIGIN=https://docs.example.net`（不含路径或尾部斜杠）、`COOKIE_SECURE=true`；外部 HTTPS 端口为非默认值时也要写入 origin，例如 `https://docs.example.net:8443`。将 `PORT` 设为 NAS 上希望映射的端口，并保证代理目标端口与之匹配。COOKIE_SECURE 应与用户浏览器侧 HTTPS 访问一致。

## 备份与恢复

备份可在宿主机通过 Node 24 执行：

```sh
DATA_DIR=/path/to/teamshelf-data node scripts/backup.mjs /path/to/backups/teamshelf-2026-09-25.sqlite
```

Windows PowerShell 示例：

```powershell
$env:DATA_DIR = 'D:\TeamShelf\data'
node scripts/backup.mjs 'D:\TeamShelf\backups\teamshelf-backup.sqlite'
```

脚本使用 Node SQLite 在线备份 API，备份期间可继续使用应用；目标文件已存在时会拒绝覆盖。备份中包含用户凭据哈希和文档内容，应限制备份目录访问权限。

恢复前先停止应用，并确认 `DATA_DIR/.teamshelf.lock` 已消失。服务正常关闭会自动移除锁；若异常终止留下锁，先确认所有 TeamShelf 实例已停止，再手动删除该锁文件。启动程序和恢复脚本都不会自动清理残留锁。Compose 部署执行：

```sh
docker compose stop teamshelf
docker compose run --rm --no-deps -v /volume1/backups/teamshelf.sqlite:/backup.sqlite:ro --entrypoint node teamshelf scripts/restore.mjs /backup.sqlite --confirm
docker compose start teamshelf
```

将命令中的 `/volume1/backups/teamshelf.sqlite` 替换为 NAS 上实际备份文件的绝对路径；也可在 NAS 宿主机上将 `DATA_DIR` 指向数据目录运行脚本。脚本要求显式 `--confirm`，校验源库的 `PRAGMA integrity_check`，遇到任何现存锁即拒绝（请先确认所有实例停止，再人工清理残留锁）；成功前会将当前数据库保存成带时间戳的 `.rollback-*.sqlite` 副本，再清除已停止服务留下的 WAL/SHM 边车文件并安装恢复库。启动失败时停止应用，使用回滚副本再次运行 restore。恢复完成后所有现有会话都会失效，用户需要重新登录；尚未使用的邀请会被撤销，管理员需重新发送邀请。文档正文和已使用邀请记录会保留。

## 升级与回滚

升级前先做数据库备份，然后更新项目文件：

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 teamshelf
```

如果新版本不能正常启动，先停止服务，使用升级前的备份恢复数据库，再切回旧项目版本并重新构建启动。Docker 命名卷在删容器、重建镜像和更新项目时保留；删除卷会删除唯一在线数据库，不要把删除卷作为普通升级步骤。

## 无 Docker 的 NAS

若 NAS 没有受支持的 Docker/Container Manager/Container Station，先在 NAS 厂商应用中心确认是否有容器管理套件可安装。没有可用容器运行时的 NAS 不能直接运行此 Compose 部署；可在局域网内已有的 Docker 主机运行服务并将数据库留在该主机本地卷，再通过 NAS 反向代理或局域网地址访问。不要将 SQLite 数据卷改为 SMB/NFS 挂载以绕过这个限制。

参考：[Docker Compose startup order and health checks](https://docs.docker.com/compose/how-tos/startup-order/)、[SQLite Online Backup API](https://www.sqlite.org/backup.html)、[Node.js 24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。
