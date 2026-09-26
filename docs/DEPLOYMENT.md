# TeamShelf 部署、备份与恢复

TeamShelf 使用 Node.js 24 提供网页与 API，SQLite 数据库位于 DATA_DIR/teamshelf.sqlite。服务按单实例运行。先在[README 运行方式表](../README.md#选择运行方式)中选择本机、源码 Compose 或经过验证的固定 digest 发布；不要让两种 Compose 更新器同时管理同一实例。

## Windows 本机

需要 Windows PowerShell 7、Node.js 24 LTS 和 npm。在项目目录运行：

    pwsh -NoProfile -File .\scripts\start-local.ps1

启动器在依赖缺失时运行 npm ci；只在 .env 不存在时创建一次性配置；然后构建生产版并运行单个 Node 服务。新配置默认访问 http://localhost:8080；已有 .env 时以其中的 APP_ORIGIN 为准。按 Ctrl+C 正常停止并释放数据库锁。

开发时可使用：

    pwsh -NoProfile -File .\scripts\start-dev.ps1

此入口在一个终端启动 API 和 Vite，网页地址为 http://localhost:5173。生产与开发服务不要同时操作同一 DATA_DIR。

### 首次初始化

启动器/配置器创建的 .env 包含一次性 SETUP_TOKEN。第一次打开网页时输入 token 创建第一个 owner，并另外设置网页登录密码。密码不是 setup token。以后使用邮箱和密码登录；初始化成功后 setup token 不再用于普通登录。

不要提交 .env、复制 token 到终端参数、截图或日志。已存在的 .env 不会被本机启动器覆盖。

## 源码 Docker Compose

源码部署器当前使用 checkout 中的 compose.yaml。Linux/NAS 需要 Docker Engine、Compose v2、Bash、awk、realpath、stat、date；Windows 需要 Docker Desktop Linux 容器、PowerShell 7、Git for Windows（Bash 与 cygpath）。宿主无需 Node.js；配置和数据库备份由 Node 24 临时容器执行。

首次运行前选择并记录：

- Compose 项目名，例如 teamshelf。
- Docker named volume 的准确名称，例如 teamshelf-data。已有安装必须从现有容器/卷查询，不能猜名字。
- checkout 之外的持久备份目录。Linux 首次安装可指定一个尚不存在的专用目录；source-up/nas-up 会创建它，并设置为部署账号拥有、容器 GID 1000 可写（0770）。Windows 入口不执行 chown，而会实际验证容器 UID 1000 是否可写。不要预先创建或 chmod 该目录；已有目录权限不会被修改，必须同时允许当前部署账号管理锁文件、应用 UID 1000 写入备份，并在 Docker daemon 主机上以同一绝对路径可见。
- 用户真正访问的 origin。HTTP 局域网示例为 http://192.168.1.20:8080；HTTPS 反向代理示例为 https://docs.example.net。不要在 origin 后写路径或尾斜线。

Linux/NAS 首次安装示例：

    bash deploy/source-up.sh --project teamshelf --volume teamshelf-data --backup-dir /srv/teamshelf-backups --origin https://docs.example.net --port 8080 --cookie-secure true --init-volume

Windows PowerShell 首次安装示例：

    pwsh -NoProfile -File .\deploy\source-up.ps1 -Project teamshelf -Volume teamshelf-data -BackupDir D:/TeamShelf/backups -Origin http://localhost:8080 -Port 8080 -CookieSecure false -InitVolume

首次安装需提供 origin 并显式授权 --init-volume / -InitVolume。该开关只允许创建缺失的空卷或明确确认的空初始化卷，不清除或替换已有数据。打开命令中的 origin；网页首次设置使用 .env 中生成的 SETUP_TOKEN，并单独设置 owner 密码。

后续更新使用同一项目名、volume 与 backup path，移除首次初始化参数。例如：

    bash deploy/source-up.sh --project teamshelf --volume teamshelf-data --backup-dir /srv/teamshelf-backups --origin https://docs.example.net --port 8080 --cookie-secure true

Windows 使用 source-up.ps1 与同样的参数。若已有 .env，部署器不会改写它；传入的 origin 必须与已有值相符，项目、卷和备份目录也不能在更新时偷偷换目标。

部署器会检查其他 TeamShelf 容器、Compose 项目标记、volume 身份与挂载使用者，拒绝多个实例、错卷或被其他容器占用的卷。若原数据库卷名不清楚，先从原运行容器和 Docker 卷元数据中确认；若检测到旧部署使用不同的 Compose 项目或卷，不要绕过拒绝继续启动，应先规划显式迁移和备份。

更新过程中会先构建并检查候选镜像，再停止唯一的旧实例；如果数据库存在，则通过 Node SQLite 在线备份 API 将一致性备份写到指定的宿主机目录。只有备份成功后才用同一个 external volume 启动新容器，并等待 /api/health。备份失败时会尝试重新启动旧服务，不会启动新镜像。健康检查失败时会停止新服务、保留数据库与备份、写入受限诊断文件；不会自动恢复数据库、降级 schema、切换卷或删除卷。先查看诊断和服务状态，再由管理员安排人工恢复。

## 固定 digest 更新

私有 GHCR 固定 digest 可通过 NAS 本机 `deploy/nas-up.sh` 或配置完成后的 GitHub Deploy workflow 更新。两种方式都使用同一 release 脚本、项目名、数据卷和备份目录；不可同时运行。手动 NAS 首装、镜像认证和更新命令见下方[固定 digest 安装与更新](#nas-固定-digest-安装与更新)，GitHub runner 准备步骤见[CI/CD 指南](CICD.md)。

## 在线备份

宿主安装 Node.js 24 时，可以在服务运行期间使用 SQLite 在线 backup API：

    DATA_DIR=/srv/teamshelf-data node scripts/backup.mjs /srv/teamshelf-backups/teamshelf-2026-09-26.sqlite

PowerShell 示例：

    $env:DATA_DIR = 'D:/TeamShelf/data'
    node scripts/backup.mjs 'D:/TeamShelf/backups/teamshelf-backup.sqlite'

目标必须是新的文件名；脚本拒绝覆盖现有文件并检查备份完整性。备份包含文档与密码哈希，应限制目录访问，并使用 NAS 自己的持久备份/异地保护策略。源码 Compose 更新器会自动在备份目录写入时间戳备份；固定 digest 更新使用 release 脚本配置的备份路径。

## 恢复

恢复时先停止全部 TeamShelf 实例。Docker Compose Linux/NAS 部署可使用相同配置的临时服务容器；以下命令保留 Compose 项目和外部 named volume，仅将备份文件只读挂载：

    docker compose stop teamshelf
    docker compose run --rm --no-deps --volume /srv/teamshelf-backups/teamshelf.sqlite:/backup.sqlite:ro --entrypoint node teamshelf scripts/restore.mjs /backup.sqlite --confirm
    docker compose start teamshelf

将示例路径替换为实际备份文件绝对路径。若宿主机直接运行 Node 24，应先将 DATA_DIR 指向数据库所在目录，再执行 DATA_DIR=/srv/teamshelf-data node scripts/restore.mjs /srv/teamshelf-backups/teamshelf.sqlite --confirm。具体目录必须对应同一个目标数据库；不要在应用运行期间直接覆盖 SQLite、WAL 或 SHM 文件。如果恢复程序提示活动锁，先确认所有实例都已停止；不要盲目删除锁文件。

恢复程序先验证备份完整性，并在覆盖当前数据库前创建 rollback 副本。成功恢复会撤销现有会话、未撤销 Agent PAT 与未使用邀请，用户需重新登录，管理员需要重新发邀请。恢复数据库启动时会使用当前程序版本的兼容初始化逻辑；不要手动降低 schema 版本。若恢复后应用无法健康启动，停止实例、保留 rollback 副本和原备份，再由管理员评估恢复方案。

## 不可省略的安全约束

- 数据库留在 NAS 本地 Docker named volume；不要将活动库放在 SMB/NFS 共享目录。
- 同一卷只运行一个 TeamShelf 写入实例。
- 备份目录放在 checkout、容器层、/tmp 和 /var/tmp 之外，并确认它是持久路径。
- 不用 docker compose down -v 作为更新或故障处理步骤。
- HTTPS 代理应设置精确的外部 APP_ORIGIN，并启用 COOKIE_SECURE=true。
- NAS 型号及厂商 runner 环境未逐一实测。保证 runner 与 Docker daemon 能看到相同的备份绝对路径，并满足部署脚本要求。

## NAS 固定 digest 安装与更新

私有 GHCR 镜像需先在 Docker daemon 所在 NAS 登录：

    docker login ghcr.io -u YOUR_GITHUB_USERNAME

在交互提示中粘贴具有 read:packages 权限的 GitHub classic PAT；不要将 PAT 作为命令参数或写入 .env。GitHub Actions 的受控部署使用其短期 GITHUB_TOKEN，无需用户配置 PAT。

deploy/nas-up.sh 通过固定 digest 首装或更新，不接受浮动 tag。首次需明确指定卷、外部备份目录、用户可访问的 origin、完整镜像 digest，并加 --init-volume。将下面占位文本替换为成功 CI 发布 metadata 中 imageRef 的完整 digest；不要原样执行占位值：

    bash deploy/nas-up.sh --project teamshelf --volume teamshelf-data --backup-dir /srv/teamshelf-backups --origin https://docs.example.net --image-ref 'ghcr.io/zhao-zixi/team-docs@sha256:REPLACE_WITH_64_LOWERCASE_HEX' --port 8080 --cookie-secure true --init-volume

已有安装会从本地 .env 读取配置并拒绝项目、卷、备份目录或 origin 不一致；后续版本用新可信 digest 调用同一命令，但移除 --init-volume。配置器只在缺少 .env 时创建它，不覆盖已有文件。NAS 更新与源码 Compose 更新不要并行，也不要对同一数据库卷执行两套更新器。

GitHub 自动部署需预先完成 runner 与仓库变量配置，详见[GitHub CI/CD 指南](CICD.md)。
