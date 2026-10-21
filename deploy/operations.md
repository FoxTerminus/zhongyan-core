# 单机运维、加密备份与恢复

这些工具面向现有 Linux、rootful Docker Compose 部署，不购买资源、不连接模型、不自动升级镜像。所有命令在源码根目录执行。需要 Node.js 24 或兼容更新版本、Docker Compose、GNU cp/tar/du 和 age。首次使用先在目标 Linux 验证工具及隔离恢复，不能把本地替身测试视为生产备份已通过。

## 健康检查

```sh
node deploy/check-health.mjs --root "$PWD"
```

检查 runner/server 的实际 Docker 健康状态、proxy 进程、至少 2 GiB 剩余磁盘、公共 HTTPS 证书和 `/health` 协议版本。证书不足 48 小时、进程未就绪、空间不足等情况均返回非零；48 小时预警、24 小时严重，正常情况下由 Caddy 自动续期。输出只包含固定检查名称与非敏感摘要；不携带设备密钥，不获取模型目录，不刷新授权或调用模型。服务器自身探测不能替代手机外网测试。

下文的 systemd timer 每 5 分钟执行巡检，并将非敏感状态原子写入供客户端读取的目录。故障提示显示在已打开且能连接服务的客户端内；尚未接入系统推送或独立外部监控，不能称作锁屏推送或服务器失联时的外部告警。异常时先看容器状态、磁盘、时间同步、80/443 入站和 ACME 出站；不要用跳过证书校验或改成 HTTP 掩盖故障。现有短期证书由 Caddy 自动续期，不需要定时重启 Caddy。

## 密钥与备份位置

使用 age 的 X25519 密钥对：备份服务器只需要公钥，解密私钥保存在独立受保护位置。私钥不能进入 Git、聊天记录、命令参数或普通日志。生成示例在受保护管理环境执行：

```sh
umask 077
age-keygen -o /secure/offline/zhongyan-backup-key.txt
age-keygen -y /secure/offline/zhongyan-backup-key.txt > /secure/offline/zhongyan-backup-recipient.txt
```

只将后一份公钥文件配置给备份服务器；它应只包含一行 `age1...` 公钥。需要恢复时才将私钥放到管理员控制的临时位置，权限 0600。私钥丢失无法解密；公钥不会恢复私钥。脚本不生成或上传密钥。

备份输出父目录须预先存在、属于运行用户、权限为 0700，例如 `/srv/zhongyan-backups`；每次输出使用全新子目录。恢复父目录也需 0700。不得将备份输出放在源码内或数据卷内，不得复用已有备份/恢复目录。手工备份脚本不自动删除历史备份；自动调度只按下文受控命名规则保留最近 7 份验证成功的自动副本，不默认使用收费存储。

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

手工备份会短暂停服，并使当时正在执行的任务成为中断状态。自动备份先建立维护闸门，确认队列、执行任务和 worker 全部空闲后才停服；忙时不停止服务，下一轮重试。安排在空闲时进行，和升级串行；不要同时手动操作容器或写入卷。每条外部操作有超时，加密/复制/解密/解包各次最长 10 分钟；普通命令通常 30 秒。备份收到 SIGINT/SIGTERM 后会在当前有界步骤结束后取消并恢复服务。SIGKILL、宿主断电或磁盘故障无法保证 finally 执行：检查原服务状态、残留 `.operations-lock` 和明文 `.staging`，确认没有存活运维进程后再人工处理，不能盲删锁后并发运行。

只有同时存在 `manifest.json`、`snapshot.tar.gz.age` 且摘要匹配，才是完整备份。失败目录可能包含不完整密文，不得用于恢复。SHA256 用于检测损坏，age 提供密文认证；不应把来自不明来源的归档当作可信备份。

服务器同盘副本不能应对整台主机丢失。将完整加密备份目录复制到用户已有的独立设备或存储，核对摘要，不需要电脑常驻。私钥与备份分开保管。自动调度保留最近 7 份完整校验成功的自动备份；现有手工备份和独立设备副本不会被清理。应定期把最新完整密文复制到独立位置并重复恢复演练。

## 自动调度与维护闸门

需要先部署支持 `/v1/operations` 的 server。host 上的状态目录只放 `health.json`、`backup.json`、`maintenance.json` 三类非敏感状态，root 所有、0755，JSON 文件 0644。密钥、原始服务日志和备份归档不能放在这里。Compose 将 `${AGENT_OPERATIONS_STATE_DIR:-./.operations-state}` 以只读方式挂载到 server 的 `/operations`；应用不能写闸门或取得 Docker 权限。`prepare.mjs` 为未启用调度的手工部署创建空的默认目录，此时客户端明确显示巡检、备份尚未配置。

示例安装（路径仅为示例，可替换；调度器不会购买资源）：

```sh
sudo node deploy/install-schedule.mjs \
  --root /opt/zhongyan/app \
  --state /opt/zhongyan/operations \
  --backups /opt/zhongyan/backups \
  --recipient /opt/zhongyan/backup-recipient.txt \
  --node /usr/local/bin/node \
  --config /etc/zhongyan/operations.json
```

安装器只写 root 配置和 systemd 单元，不启动定时器、不登录模型。已有目录权限不匹配、已有文件内容不同会拒绝覆盖。修改部署环境 `AGENT_OPERATIONS_STATE_DIR=/opt/zhongyan/operations`，在维护窗口重建 server 后，先确认鉴权 `/v1/operations` 能读取此挂载且维护闸门生效，再启用：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now zhongyan-health.timer zhongyan-backup.timer
sudo systemctl start zhongyan-health.service
sudo systemctl start zhongyan-backup.service
sudo systemctl list-timers zhongyan-health.timer zhongyan-backup.timer
```

默认每天 UTC 20:30（北京时间次日 04:30）执行备份，可用安装参数 `--hour` / `--minute` 配置 UTC 时刻。timer 每 15 分钟检查是否到期；首次没有成功记录会立即补一份，忙时延期重试。成功后按最近计划时刻判断是否完成，不会在同一计划槽位重复；首次补备份后仍回到下一次 04:30。无需电脑常驻。

调度先持有独占锁并写入 15 分钟维护闸门，每 30 秒续租。通过现有 server 内的固定 loopback 请求检查队列、执行中的任务和 worker，且要求响应中的 operationId 与本次相同、闸门剩余至少 2 分钟；取密钥只在 server 内存完成，不输出。检查失败不开始停服。空间和卷预检后、实际停服前会再次检查，防止预检期间状态变化。server 在同一事件循环中检查闸门并拒绝发送/重试等写入，既有任务允许完成。恢复原有容器运行后立即移除闸门，加密阶段不阻止用户使用。只启动原来已存在且运行的容器，不 `compose up`、不启动第二个 runner。

自动备份目录严格使用 `auto-v1-<UTC时间>-<UUID>`。本次加密归档完成后，保留策略只检查该命名空间：每个候选必须是受保护普通目录，恰有两份普通文件 `manifest.json` 和 `snapshot.tar.gz.age`，卷清单、文件大小、SHA256 全部匹配。本次成功未获验证前不删除旧副本；通过后保留最新 7 份，仅逐项删除已验证的两个文件和空目录，不做递归清理。手工备份、名称不符、额外文件、损坏或不完整副本全部保留并提示检查。SHA256 验证不是离线解密恢复演练，后者仍需私钥及既有 `restore.mjs`。

失败状态与最近一次成功记录同时保存；一次失败不隐藏可用旧副本。清理失败时保留新成功记录并显示保留策略警告。状态文件原子替换，独立备份/巡检锁阻止重叠。健康巡检每 5 分钟检查服务、HTTPS API、证书和磁盘；不调用模型、不刷新 ChatGPT 授权。检查过期、从未成功备份、长期无新备份均由客户端显示异常状态。

systemd 限制健康检查 4 分钟；备份最多 90 分钟并给取消清理额外 12 分钟。子命令本身也有超时。取消、进程崩溃或断电可能遗留锁；调度不会盲目抢锁。先用 `systemctl status zhongyan-backup.service zhongyan-health.service`、`journalctl -u zhongyan-backup.service` 检查，再核对原容器和残留暂存。确认没有仍在运行的运维进程后，管理员才能清除具体残留锁/维护标记；不要删除整个状态或备份目录。长时间 running / 过期巡检会提示异常。证书续期仍由 Caddy 负责，检查不会重启 Caddy或绕过 TLS 校验。

同盘 7 份密文只能抵御部分误操作和应用数据损坏，不能抵御主机或云账号丢失。当前没有额外购买异地存储；应定期复制完整密文到已有独立设备，私钥独立保管，绝不常驻 VM。客户端内提示不等于手机通知栏推送；服务完全失联时，客户端连接失败提示仍可见，但无法从失联服务获取最新运维详情。

```sh
node --test deploy/test/scheduled-operations.test.mjs deploy/test/operations.test.mjs deploy/test/read-secret.test.mjs
```

调度测试覆盖忙时延期、二次闸门确认、停服复制异常后恢复与释放闸门、失败持久化、并发锁、损坏归档不删除、仅清理受控成功副本、原子状态写入、48/24 小时证书阈值、初次补备份后回到计划时刻，以及 systemd 配置。Linux 还执行真实符号链接与文件权限场景；Windows 会明确跳过 POSIX 专属检查。替身测试不代表生产 systemd、实际 age 加密或真实云端备份已验证，启用后必须记录现场检查结果。

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
