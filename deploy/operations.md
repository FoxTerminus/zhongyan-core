# 单机运维、加密备份与恢复

这些工具面向现有 Linux、rootful Docker Compose 部署，不购买资源、不连接模型、不自动升级镜像。所有命令在源码根目录执行。需要 Node.js 24 或兼容更新版本、Docker Compose、GNU cp/tar/du 和 age。首次使用先在目标 Linux 验证工具及隔离恢复，不能把本地替身测试视为生产备份已通过。

## 健康检查

```sh
node deploy/check-health.mjs --root "$PWD"
```

检查 runner/server 的实际 Docker 健康状态、proxy 进程、至少 2 GiB 剩余磁盘、公共 HTTPS 证书和 `/health` 协议版本。证书不足 24 小时、进程未就绪、空间不足等情况均返回非零。输出只包含固定检查名称与非敏感摘要；不携带设备密钥，不获取模型目录，不刷新授权或调用模型。服务器自身探测不能替代手机外网测试。

可以将此命令加入服务器自己的 systemd timer，每 6 小时运行，标准输出/错误写入受保护日志；首次应检查退出码和日志。尚未连接通知渠道时，只能称作定期检查，不能称作已向用户告警。异常时先看容器状态、磁盘、时间同步、80/443 入站和 ACME 出站；不要用跳过证书校验或改成 HTTP 掩盖故障。现有短期证书由 Caddy 自动续期，不需要定时重启 Caddy。

## 密钥与备份位置

使用 age 的 X25519 密钥对：备份服务器只需要公钥，解密私钥保存在独立受保护位置。私钥不能进入 Git、聊天记录、命令参数或普通日志。生成示例在受保护管理环境执行：

```sh
umask 077
age-keygen -o /secure/offline/zhongyan-backup-key.txt
age-keygen -y /secure/offline/zhongyan-backup-key.txt > /secure/offline/zhongyan-backup-recipient.txt
```

只将后一份公钥文件配置给备份服务器；它应只包含一行 `age1...` 公钥。需要恢复时才将私钥放到管理员控制的临时位置，权限 0600。私钥丢失无法解密；公钥不会恢复私钥。脚本不生成或上传密钥。

备份输出父目录须预先存在、属于运行用户、权限为 0700，例如 `/srv/zhongyan-backups`；每次输出使用全新子目录。恢复父目录也需 0700。不得将备份输出放在源码内或数据卷内，不得复用已有备份/恢复目录。脚本不自动删除历史备份，不默认使用收费存储。

部署源码可以由 `ubuntu` 等部署账号拥有；源 `deploy/.secrets` 须与源码根目录属于同一 UID，权限仍须 0700。备份以 root 读取它，不要求改变线上源码所有权。备份/恢复输出父目录及解密私钥仍必须属于当前运维用户 root，不接受部署账号所有的输出目录。

## 一致性备份

```sh
sudo node deploy/backup.mjs --root "$PWD" \
  --out /srv/zhongyan-backups/backup-2026-10-21T120000Z \
  --recipient /secure/zhongyan-backup-recipient.txt
```

该工具只支持当前完整 plan 部署，必须已经存在单个 server、runner、proxy 容器及以下五个本地卷：

| 范围 | 需要一起保留的内容 |
|---|---|
| `agent_data` | 任务、会话、消息、事件、资料库以及 SQLite WAL/SHM |
| `runner_state` | 独立应用 profile、VM host 身份、Codex 线程历史和运行状态 |
| `runner_workspace` | 执行器工作资料 |
| `caddy_data`、`caddy_config` | ACME 账户、证书私钥及代理持久状态 |
| 部署文件 | `deployment.env`、两枚 `.secrets` 密钥、两份 Compose 文件 |

顺序如下：

1. 检查公钥格式、工具、源路径和文件类型；确认磁盘至少可容纳约两份数据与余量，拒绝未知卷布局。
2. 创建独占操作锁，记录原容器、运行状态及镜像摘要。按 proxy → server → runner 停止原本运行的服务；确认卷没有其他运行容器写入。
3. 将完整卷复制至 0700 临时目录，保留所有权、模式和时间戳。SQLite 与 runner 状态均停止写入后才复制，不能只复制正在工作的 `.sqlite` 文件。
4. 不论停止/复制成功与否，尝试按 runner → server → proxy 启动所有原本运行的容器；原本停止的服务保持停止。恢复启动失败会明确报错，不返回成功。
5. 对独立副本生成 age 加密归档，输出 SHA256/大小清单，再清理明文暂存。加密期间线上服务已经恢复。

运维会短暂停服，并使当时正在执行的任务成为中断状态。安排在空闲时进行，和升级串行；不要同时手动操作容器或写入卷。每条外部操作有超时，加密/复制/解密/解包各次最长 10 分钟；普通命令通常 30 秒。备份收到 SIGINT/SIGTERM 后会在当前有界步骤结束后取消并恢复服务。SIGKILL、宿主断电或磁盘故障无法保证 finally 执行：检查原服务状态、残留 `.operations-lock` 和明文 `.staging`，确认没有存活运维进程后再人工处理，不能盲删锁后并发运行。

只有同时存在 `manifest.json`、`snapshot.tar.gz.age` 且摘要匹配，才是完整备份。失败目录可能包含不完整密文，不得用于恢复。SHA256 用于检测损坏，age 提供密文认证；不应把来自不明来源的归档当作可信备份。

服务器同盘副本不能应对整台主机丢失。将完整加密备份目录复制到用户已有的独立设备或存储，核对摘要，不需要电脑常驻。私钥与备份分开保管。初期可保留最近三份已验证备份；清理旧副本前必须确认至少一份独立位置的恢复演练成功，脚本不会代做删除。

## 离线恢复演练

```sh
sudo node deploy/restore.mjs \
  --backup /srv/zhongyan-backups/backup-2026-10-21T120000Z \
  --out /srv/zhongyan-restore/drill-2026-10-21T123000Z \
  --identity /secure/restore/zhongyan-backup-key.txt
```

它校验清单、密文大小与 SHA256，再解密到全新受保护目录。脚本拒绝已有输出目录，GNU tar 的 `--keep-old-files` 还会拒绝覆盖解包目标中的已有文件；不与互斥的 `--no-overwrite-dir` 同时使用。tar 解包在临时容器中进行：无网络、只读根、没有线上卷或 Docker socket，只挂载归档只读和全新恢复目录可写；仅保留还原文件所有权所需的 capability。容器使用清单记录的本地 server 镜像，`--pull never`，不会下载或启动应用。若旧镜像已不在本机，先按对应源码准备可信兼容镜像，再显式提供 `--image`。

成功后 `contents/volumes/` 包含五卷离线副本，`contents/deployment/` 包含部署文件，`RESTORE-READY.json` 记录两份 SQLite 的版本、必要业务表/列、`PRAGMA integrity_check` 和 `foreign_key_check` 检查结果。恢复校验不会创建缺失表或自动迁移；数据库版本变化时应同步更新兼容性检查，并使用与备份匹配的工具。检查也会拒绝主库及 WAL/SHM/journal 旁文件的链接或特殊文件。

解包中间明文 tar 会清理，恢复数据仍是敏感明文，整个父目录必须保持 0700。恢复收到 SIGINT/SIGTERM 会终止当前外部操作、检查并删除本次独立容器，再清理中间归档；若 Docker 无法确认清理，错误会给出该临时容器名，必须人工检查。SIGKILL 或断电仍可能遗留容器及中间归档。失败时不创建 READY 标记，隔离副本可能不完整；线上服务不会被替换。

该工具完成离线恢复准备，不代表已切换生产服务、模型凭据仍有效或新机器可用。演练不得启动第二份读取同一 ChatGPT profile 的 runner，否则可能竞争轮转 refresh token。旧备份中的 refresh token 在后续刷新后可能失效；旧磁盘快照不能保证恢复账户授权。

真正回滚/灾难恢复时：

1. 明确使用对应备份与兼容的代码/镜像，停止旧服务，并为仍可读的当前数据再保留独立副本。
2. 创建全新目标卷，将验证后的各卷内容及所有权复制进去；通过受审阅 Compose 覆盖配置指向这些新卷，保留原卷，避免直接覆盖在线卷。
3. 恢复部署配置和两枚连接密钥；宿主 `.secrets` 为 0700、文件 0444，runner profile 目录属于容器 UID 且为 0700、文件为 0600。旧设备需要与恢复后的设备密钥匹配。
4. 同一 VM 的恢复与迁移新 VM 区分处理：新 VM 须准备独立 host ID，再通过现有 `import-stdin` 导入最新本应用授权，不能把备份中的旧 host 身份直接当作新主机。Codex 线程历史需要与业务库一同恢复。凭据过期或轮转失效时，由账号本人完成官方重新授权。
5. 确认只有目标 runner 使用这份授权，再启动服务；验证健康、HTTPS、已有历史、两轮真实续接、取消和重启恢复。数据库 schema 若已改变，必须恢复与旧代码匹配的数据，不能仅降级二进制。

## 更新与回退

不做无通知的自动 `git pull`、自动切换模型或 `docker system prune`。更新前记录当前源码提交与三份镜像 ID，完成加密备份和离线演练；先构建并运行目标版本测试，再进入短维护窗口切换。保留旧镜像、旧卷和匹配的备份。更新失败时按上述恢复路径回退，不能使用 `docker compose down --volumes` 清理生产数据。一次成功备份不等于持续可恢复；升级 Docker、Node、age 或卷布局后重复演练。

## 开发验证范围

```sh
node --test deploy/test/operations.test.mjs
```

覆盖停服/复制失败后恢复原服务、停止状态保留、启动失败继续恢复其他服务、已有输出拒绝覆盖、清单范围与摘要、真实合成 SQLite 的完整性/版本/缺表/外键损坏/旁文件链接、取消信号中止子进程后执行清理、恢复容器隔离参数及清理失败、命令退出码诊断不泄露输出、健康检查不发送凭据和响应大小限制。在 Linux 上额外调用实际 GNU tar，创建合成归档、解包并验证已有文件不会被覆盖；Windows 明确跳过这条 Linux 行为测试。Docker 状态使用替身；Windows 测试不验证 Linux 文件权限、age 加解密、GNU tar 所有权或真实容器启动。生产启用前须在目标 Linux 运行这些测试并完成一次合成数据或正式备份的离线演练，记录实际结果。
