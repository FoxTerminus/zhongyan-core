# 使用公网 IPv4 的 HTTPS

本选项用于没有域名的单用户服务器。应用连接地址为 `https://服务器公网IPv4`；无需在手机或电脑安装根证书。这里提供的是部署配置，离线解析成功不代表证书已签发或真实设备已联通。

在 `deployment.env` 设置 `AGENT_TLS_MODE=ip`，将 `AGENT_DOMAIN` 填成服务器实际公网 IPv4（不带协议、端口或路径）。保留 `AGENT_DOMAIN` 名称是为了兼容现有配置；以后改用域名时，将模式改为 `domain` 并更新该值即可。预检查拒绝内网、回环、组播、文档示例和非标准数字地址，不会查 DNS、确认地址所有权或发起 ACME 请求。

先运行 `node deploy/preflight.mjs`。Compose 按模式选择镜像内的 `Caddyfile.ip` 或 `Caddyfile.domain`。当前测试基线为 Caddy 2.11.7，基础镜像可经 `CADDY_IMAGE` 更新；升级后应重复配置测试并记录镜像摘要。

IP 模板明确指定 Let's Encrypt 公共 ACME 端点及 `shortlived` profile；不使用 Caddy 本地 CA。容器内设置 `default_sni`，使不发送 SNI 的 IP 客户端也能选择正确证书。公网 TCP 80/443 必须映射到容器 8080/8443，并保持防火墙允许证书验证；HTTP 跳转使用公网 443，不将内部 8443 暴露在链接中。代理应可向公网发起 ACME HTTPS 请求。正式启动代理后才会创建 ACME 账户并申请证书；当前代码测试不会启动代理。

## 续期与到期检查

这类证书有效期约 160 小时。Caddy 自动申请和续期，无需另写定期重启任务。持续保留 `caddy_data` 卷、系统时间同步和验证端口连通，升级时不删除该卷。卷包含私钥和 ACME 账户，应纳入受保护的恢复方案。服务器 IP 改变后须更新部署与客户端地址，并为新 IP 取得新证书。

上线后，从能访问目标服务器的主机显式执行：

```sh
node deploy/check-tls.mjs --host 你的服务器公网IPv4 --minimum-hours 24
```

该工具只做 TLS 握手，验证系统信任链、目标地址和有效期，不携带应用密钥，不发送 HTTP 请求，也不会申请或续期证书。无参数只显示用法；有效证书剩余不足 24 小时、已过期、不受信任、地址不符或连接失败均返回非零。输出剩余小时数和到期时间，可由部署后的监控每 6 小时执行并对失败告警；监控尚未安装，需上线后验证通知渠道。应至少有一次从服务器外部进行的连通性检查，避免只检查到本机仍正常。

出现临期告警时检查代理日志、80/443 防火墙、ACME 出站连接、系统时钟及卷写入权限。不要以跳过证书验证、改用 HTTP 或给客户端安装临时根证书来消除告警。

## 离线回归验证

普通测试不下载软件、不连接公网，也不申请证书：

```sh
node --test deploy/test/tls-config.test.mjs deploy/test/caddy-config.test.mjs
```

完整解析验证需显式将 `CADDY_BIN` 指向已校验来源的本地 Caddy 可执行文件，再执行相同测试。测试只调用 `caddy adapt`，不使用 `run` 或 `--validate`。未配置二进制时，两个真实解析用例会标为跳过；不能将跳过报告为已完成验证。

参考：[Let's Encrypt 公网 IP 证书与 160 小时期限](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy ACME profile](https://caddyserver.com/docs/caddyfile/directives/tls)、[容器内 IP 证书的 default_sni](https://github.com/caddyserver/caddy/issues/7118)、[Caddy adapt](https://caddyserver.com/docs/command-line#caddy-adapt)。
