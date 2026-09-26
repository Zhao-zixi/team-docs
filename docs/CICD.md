# GitHub 发布与 NAS 自动更新

GitHub Actions 先验证代码与容器，再发布不可变 GHCR digest；只有发布 job 的真实临时卷安装、同 digest 重部署与备份 smoke 全部成功，才生成可信 release metadata。Deploy workflow 只从同一成功 main CI run 读取这个 metadata。

CI 云端 smoke 不代表 NAS 生产部署已发生，也不能验证 NAS 设备、网络挂载、断电恢复或现场 runner 配置。

## 从提交到镜像

Pull Request 与 main push 运行 .github/workflows/ci.yml，包括类型检查、单元/API/运维测试、release 脚本 fail-closed mock、生产浏览器 E2E、stdio 桥和加固 Docker health smoke。main CI 全绿后，publisher 构建多架构容器并推送 GHCR。候选版本用源码 SHA、run ID 和 attempt 标识；部署时不使用标签，而使用完整 SHA-256 digest。

成功发布后上传名为 release-metadata 的 artifact，内容格式为：

    {
      "sourceSha": "<成功 main CI run 对应的 40 位小写提交 SHA>",
      "imageRef": "ghcr.io/zhao-zixi/team-docs@sha256:<64 位小写摘要>"
    }

发布 job 在隔离的临时 named volume 上真实运行部署脚本，验证首次初始化、同 digest 第二次部署与备份文件。只有该烟测成功后才创建和上传 metadata。部署流程不接受浮动 tag、本地构建镜像或不属于固定 GHCR 仓库的引用。

## 安全地校验与部署

Windows 管理员也可用仓库 helper 发起安全的默认校验：`pwsh -NoProfile -File .\deploy\deploy-release.ps1 -RunId 123456789`。默认只提交 validate-only dispatch；只有明确加入 `-Deploy` 才会请求 NAS 部署，首次卷初始化另加 `-InitVolume`。使用前需安装并登录 GitHub CLI，且有权访问私有仓库。

先在 GitHub Actions 手动运行 Deploy verified release，选 main 分支并填一个成功 main CI run ID。默认 validate_only=true 仅在云端验证来源与 metadata，不会联系或排队到 NAS runner：

    gh workflow run deploy.yml --repo Zhao-zixi/team-docs --ref main -f run_id=123456789 -f validate_only=true -f init_volume=false

校验确认 run 属于本仓库 main 的 push 事件、ci.yml workflow 且成功；artifact 中 sourceSha 必须与 run 的提交匹配，imageRef 必须是固定 GHCR 仓库的完整 digest。

确认该 run 和目标环境后，再提交一次 dispatch，将 validate_only 设为 false。只有确认首次目标是空卷且需要初始化时才将 init_volume 设为 true；常规更新保持 false。初始化参数只向 NAS release 脚本传递显式开关，不会清空已有数据库或替换卷。

## 准备 self-hosted NAS runner

实际部署要求管理员预先配置受仓库控制的 Linux self-hosted runner，并设置 GitHub 仓库 Variables：

| Variable | 用途 |
| --- | --- |
| NAS_DEPLOY_READY | 只有部署环境准备完成后设为精确值 true |
| NAS_RUNNER_LABEL | 与所注册 runner 的自定义标签一致 |
| TEAMSHELF_ENV_FILE | NAS runner 上本地 .env 的绝对路径 |

runner 需要匹配 self-hosted、linux 与 NAS_RUNNER_LABEL 标签。云端 preflight 在安排部署任务前验证门禁变量；缺少配置时直接失败，不会将任务排队到未知 runner。

NAS runner 需要 Docker Engine、Docker Compose v2、Bash 4+、jq、flock、realpath、stat、awk 与 date。NAS 本机手动运行 `deploy/nas-up.sh` 还要求 `id`、`ln`，并在 Docker daemon 所在主机预先 `docker login ghcr.io`；私有镜像登录使用具备 `read:packages` 权限的 GitHub classic PAT，通过交互提示输入，不要将 PAT 放入命令行或日志。Docker daemon 主机必须能通过脚本使用的同一绝对路径访问 TEAMSHELF_BACKUP_DIR，Node 应用 UID 1000 要能写入该目录。NAS 启动器只对自己新建的备份目录设置部署账号所有权与容器 GID 1000 写权限；既有目录权限不会被更改，必须同时允许部署账号管理目录锁并允许 UID 1000 写入。若 runner 位于容器中，需验证容器路径与 Docker daemon 主机的 bind mount 路径完全一致。GitHub Actions 不托管 NAS 的 SETUP_TOKEN、APP_ORIGIN 或 .env；这些仅由 NAS 本地配置管理。

当前私有仓库计划不依赖 GitHub Environment approval。保护依赖成功 main CI metadata 校验、云端门禁与由管理员控制的 NAS runner 注册和权限。不要把接受不可信 PR 工作流的 runner 注册为可管理生产 Docker daemon 的 runner。Synology/QNAP 型号、厂商应用中心 runner 与容器 runner 配置没有逐一验证；不能假设所有 NAS 都兼容。

## 固定 digest 发布脚本做什么

NAS runner 在可信源码提交上检出发布脚本，临时获得 GHCR 拉取权限并运行 deploy/release.sh。脚本接受完整 digest，预检 Compose 配置、project 和 volume、单实例占用与持久备份目录；会先 pull 镜像，再停止原写入服务并创建一致性备份，成功后才用同一 volume 启动新实例并等待 /api/health。

备份失败时脚本尝试启动原服务且不启动新镜像。新实例启动或健康检查失败时，它停止新服务、保留数据卷与备份并写受限诊断日志；不自动还原数据库、降级 schema、删除 volume 或回退应用镜像。检查诊断并确认数据状态后，由操作员明确决定是否恢复。完整首次安装、更新和恢复步骤见[部署文档](DEPLOYMENT.md)。

本流程仅说明可配置后的 GitHub→NAS 部署边界；在 NAS runner、局域网/反向代理与备份存储未确认前，不要设置 NAS_DEPLOY_READY=true 或声称已完成生产部署。
