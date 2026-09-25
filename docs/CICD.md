# TeamShelf GitHub CI/CD 与 NAS 部署

本指南说明私有仓库的可信镜像发布、手动选定版本，以及在兼容 Linux Docker 主机上更新 TeamShelf。GitHub CI 先校验源码与容器；部署只接受与成功 main CI 运行绑定的 GHCR 完整 digest。未知 NAS、NAS runner 未配置或云端校验未通过时，不会发起生产部署。

## 仓库与可信镜像

源码仓库为私有仓库 Zhao-zixi/team-docs；容器发布到 GHCR 小写路径 ghcr.io/zhao-zixi/team-docs。发布标记包含源码 SHA、workflow run ID 与 attempt，例如 sha-<40位源码SHA>-run-<run_id>-<attempt>。标签仅便于查找；部署使用 immutable digest：

    ghcr.io/zhao-zixi/team-docs@sha256:<64位小写十六进制摘要>

可信 CI 成功后会上传名为 release-metadata 的 artifact，JSON schema 为：

    {
      "imageRef": "ghcr.io/zhao-zixi/team-docs@sha256:<64位小写十六进制摘要>",
      "sourceSha": "<40位小写源码提交SHA>"
    }

手动 CD 接受 workflow_dispatch 输入 run_id，只验证该仓库 main 上 push 事件的成功 CI 运行；校验 artifact 的 sourceSha 必须与该运行的 head SHA 一致，镜像必须符合固定 GHCR 仓库和完整 digest 格式。不要手工传入标签或未经可信 CI 产出的镜像地址。

部署工作流可用 validate_only（默认 true）只检查来源与配置；只有显式关闭它、并通过云端检查后才会调度 NAS runner。init_volume（默认 false）仅用于明确授权的首次空卷初始化。GitHub Free 私有仓库环境审批功能不可用，本流程不依赖 GitHub Environment approval，也不把它当作部署保护。NAS 任务通过仓库变量 NAS_DEPLOY_READY=true 与 NAS_RUNNER_LABEL 门控；缺少门控配置或 runner 不可用时，应在云端检查阶段失败，不能将工作排队到未知 runner。

GitHub Actions 使用短期 GITHUB_TOKEN 拉取/发布 GHCR 镜像；不需要把 APP_ORIGIN、SETUP_TOKEN 或 SQLite 数据发送到 GitHub。不要为便利把 NAS .env 添加为 repository variable、secret、artifact 或 workflow log。

## NAS runner 要求

部署 runner 必须是 NAS 上或可安全访问该 NAS Docker daemon 的 Linux 主机，并提供 Bash 4+、Docker Engine、Docker Compose v2、jq、flock、realpath、awk、date。脚本固定使用单实例 Compose 项目；它不适合无法运行受支持容器的 NAS。Synology/QNAP 型号和厂商自带 runner 未在本机验证，不能假设设备可直接运行 GitHub runner。

若 runner 在容器中运行，Docker daemon 解释 bind mount 路径的位置必须与部署脚本看到的路径一致；NAS 备份目录需在 runner 容器和 daemon 主机上以同一绝对路径可见。runner 应由管理员注册为仓库级 self-hosted runner，标签和 NAS_RUNNER_LABEL 必须一致。不要启用将私有仓库不受信任 PR workflow 派发到具备 NAS Docker 权限 runner 的配置。

## 准备 NAS 本地配置

用现有安装的实际 Compose 项目名和命名卷名填写本地 .env。不要根据仓库名猜它们：

    docker ps -a --filter 'label=com.docker.compose.service=teamshelf' --format '{{.ID}} {{.Names}}'
    docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' <旧容器ID>
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' <旧容器ID>

第一条若显示多个 TeamShelf 实例，先人工查明后再迁移；不要直接运行部署。现有 Compose 没有固定顶层 project name，因此 Docker volume 常见实际名称会带首次启动时的项目名前缀。脚本会核对容器 project/service labels、/app/data 真实挂载卷及卷的其他使用者；不一致时在停服前退出。

在 NAS 持久部署目录创建 .env，例如：

    TEAMSHELF_COMPOSE_PROJECT=<从现有容器读取的项目名>
    TEAMSHELF_DATA_VOLUME=<从现有容器读取的卷名>
    TEAMSHELF_BACKUP_DIR=/volume1/backups/teamshelf
    APP_ORIGIN=https://docs.example.net
    SETUP_TOKEN=<私下生成的随机初始化token>
    PORT=8080
    COOKIE_SECURE=true

为使临时checkout读取NAS持久配置，NAS runner服务环境应设置 TEAMSHELF_ENV_FILE 指向该本地文件的绝对路径（例如 /volume1/teamshelf-deploy/.env）；手工在仓库目录运行时可不设置，脚本默认读取仓库根目录 .env。该变量只留在NAS runner本机环境，不配置为GitHub secret。

TEAMSHELF_BACKUP_DIR 必须是 Docker daemon 主机上的持久绝对目录，不能位于仓库 checkout、容器层、/tmp 或 /var/tmp；UID 1000（应用 node 用户）须能通过 Docker bind mount 写入。备份包含数据库内容和凭据哈希，请设置受限目录权限并由 NAS 自己的备份策略保护。该发布入口只检查路径和写权限，不能证明底层存储在断电后持久；请确认它不是临时盘或网络共享。TeamShelf SQLite 数据卷必须留在 NAS 本地 Docker named volume，不能改为 SMB/NFS bind mount。

TEAMSHELF_IMAGE_REF 可留空不写：可信 workflow 会在当前作业环境临时注入完整 digest。手动演练脚本时必须提供同格式的真实镜像 digest。部署脚本不 source .env，不会将其中 token 作为 shell 命令执行，也不会打印它。不要把 .env 复制进 Git checkout；文件已被 .gitignore 排除，但仍要确认未添加到版本库。

首次安装时使用空数据卷，且只能在确认这个卷是首次初始化目标后，在手动 CD 中显式设置 init_volume=true。参数不会清除或替换已有卷；如果卷不存在，脚本在成功 pull 后创建它并验证应用非 root 用户可写。已有空卷也必须显式授权。如果卷中已有数据库，即使旧服务容器不在，也会先用目标镜像备份；不会将已存在但当前挂载错误的库切换成新空卷。

## 发布和更新步骤

在 GitHub Actions 页手动运行 Deploy workflow，选择已成功且可信的 CI run_id。先保持默认 validate_only=true 检查来源。确认 CI 运行提交、metadata digest 与目标无误后，再显式关闭 validate-only；首次空卷才设置 init_volume=true。没有实际 NAS 时不要伪造变量或在 hosted runner 上执行 NAS 部署。

NAS runner 执行的实际入口为：

    bash deploy/release.sh

首次初始化时：

    bash deploy/release.sh --init-volume

workflow 注入 TEAMSHELF_IMAGE_REF。脚本在触碰服务前校验 Compose 文件和镜像 digest，核对安装项目及卷、确认目标卷存在或首次初始化已明确授权，检查备份目录和非 root 写权限，并先 pull 新 digest。它通过主机级锁串行发布，拒绝第二个 TeamShelf 实例或被其他容器占用的数据卷。

更新时脚本先停止唯一的旧写入服务，再使用旧容器的 image ID（首次发布或无旧容器但已有库时使用目标镜像）执行镜像内现有的 scripts/backup.mjs。备份文件写到 NAS 宿主持久 bind 路径，不写入临时备份容器层；成功后才用同一命名卷启动新 digest，并等待内置 /api/health 检查通过。部署产生的 backup 与失败诊断文件均在 .env 配置的 NAS 备份目录中，诊断文件权限限制为 owner-only。

pull、Compose 配置、卷比对和目录写权限等预检失败时，旧服务不停止。停服后若一致性备份失败，脚本不启动新镜像，并尝试启动原容器；随后应确认原服务状态和数据库文件，再排查原因。若新容器启动或健康检查失败，脚本保留备份与旧 image ID、保存受限日志并停止新服务；它不会自动 restore 数据库、降级 schema、删卷或自动切回旧应用。先检查健康诊断、日志、schema 兼容和磁盘空间，随后由管理员按维护窗口决定恢复方案。备份可供人工恢复，但任何 restore 都应由操作员明确执行。

升级成功后可用同源站点登录确认数据。脚本只保护 Docker 部署步骤和 SQLite 一致性备份；它没有替代离线备份、异地备份、定期恢复演练或 NAS 硬件监控。

## 用 Codex 与 GitHub CLI 只读检查

若当前电脑已配置 gh 登录，先检查现有身份和私有仓库访问权限；无需为本指南重新登录：

    gh auth status
    gh repo view Zhao-zixi/team-docs
    gh workflow list --repo Zhao-zixi/team-docs
    gh run list --repo Zhao-zixi/team-docs --workflow ci.yml --limit 10
    gh run view <run_id> --repo Zhao-zixi/team-docs

下载可信 metadata 进行只读核对：

    gh run download <run_id> --repo Zhao-zixi/team-docs --name release-metadata --dir ./release-metadata-check

仅检查 imageRef 与 sourceSha 是否对应目标成功 CI run；不要把 gh auth token、.env、SETUP_TOKEN、GHCR 登录凭据或 NAS 日志粘贴到 Codex 对话、issues、PR、截图或终端录屏中。若 gh repo view 返回拒绝访问，应由仓库管理员确认你当前账号是否获邀及仓库只读权限；不要在仓库不可见时尝试匿名 API 读取。
