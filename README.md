# Personal Agent Core · 终焉服务端核心

这是采用 [MIT 许可证](LICENSE) 的个人助手服务端核心。项目仓库：[FoxTerminus/zhongyan-core](https://github.com/FoxTerminus/zhongyan-core)。开源许可与模型服务的接入资格分别验证。

本次范围只包含云端服务、共享契约和部署代码。手机与 Windows 客户端、图标、看板娘、社区人物资源及其衍生图片完全不在本包中。主项目仍可继续开发这些客户端；这里不是完整终端产品的发行版。

## 包含的代码

- `apps/server/src`：Fastify HTTP 接口、SQLite 会话/消息/任务/事件、幂等发送、排队、取消、显式重试与中断恢复。
- `apps/server/src/knowledge.ts` 与 `tools`：手动资料录入、来源、检索及不可变修订历史；实验模型资料工具默认关闭且仅提供读取。
- `apps/server/src/auth`：独立应用的 ChatGPT 套餐授权流程、PKCE/state/nonce 校验、令牌刷新和隔离的资料存储。不会读取个人桌面客户端的登录资料。
- `apps/server/src/runtime`：可替换的模型运行器；执行边界与验证范围见该目录内的 README。运行器能力与真实外部授权分别验收。
- `apps/server/src/runner`：独立运行器服务及受保护的调用协议；部署可以把任务持久化与模型进程分开。
- `apps/server/test`、`packages/contracts`：服务端行为测试与共享的 TypeScript/校验契约。
- `deploy`：部署模板、准备与预检工具、显式源码打包器及其测试；`scripts` 仅保留通用开发配置与服务启动脚本。

当前默认配置不启用模型，不自动使用另行收费的 API。微信/QQ 历史、自动回复、邮件发送、任意设备操作等能力不由这个核心包提供。

## 复现与验证

安装满足 `package.json` engines 的 Node.js。锁文件只包含服务端、契约与开发工具；不安装 Expo、React Native 或 Electron。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:deployment
npm run build
```

这些检查验证代码和协议行为，测试使用本地替身，不执行真实登录或调用用户的模型账号。本次文件树没有启用 GitHub Actions 工作流；`deploy/release-content/ci.yml` 只保留 Linux/Windows 检查模板，工作流可另行配置。目前按上述命令手动验证，本地通过不代表云端镜像构建或 iOS/Android 构建通过。

开发时可以再执行：

```sh
npm run setup
npm run dev:server
```

`setup` 创建本地 `.env` 和随机设备连接密钥，保留已有配置；默认只监听本机。不要把生成的 `.env`、数据库或授权资料提交到仓库。生产启动用 `npm start`，需要先完成编译。

## 云部署与模型授权

先阅读 `deploy/deployment.env.example` 与部署模板。`node deploy/preflight.mjs --help` 只显示只读预检说明；`node deploy/prepare.mjs` 则会创建本地部署配置与随机密钥。模板不等于已购买服务器、部署成功、HTTPS 可用或模型已接通。

完整预检在目标 Linux 主机运行，需要满足项目 engines 的宿主 Node.js 以及可访问的 Docker/Compose；不能仅在未连接宿主 Docker 的应用容器里完成。Compose 文件密钥使用 `deploy/.secrets` 目录 0700、其中两枚密钥文件 0444，让非 root 容器读取而保持宿主目录私有。准备工具明确设置新文件权限，不改动既有密钥文件；预检拒绝不匹配的权限并给出修正命令。目标 Linux 上应执行 `node --test deploy/test/read-secret.test.mjs`，Windows 跳过的 POSIX 测试不能算作 Linux 验收。

本包的 `deploy/Dockerfile` 使用核心专属工作区配置，保留服务端构建输入和运行时边界。可选 `deploy/compose.plan.yaml` 叠加独立运行器配置，`deploy/https-ip.md` 说明域名与 IP 的 HTTPS 选择。运行器镜像的 CLI 版本通过构建参数显式更新。部署运行器、公开网络入口、持久化与恢复应按具体部署配置验收。源码打包不会触发这些操作，也不会进行真实授权。

ChatGPT 套餐接入需要按适用的官方流程完成应用身份、授权及一次真实推理验证；登录成功或发现模型列表不能替代推理验证。采用 MIT 许可也不自动满足服务方对开源应用的全部接入要求。

Windows 浏览器使用系统代理时，可在本机授权命令后加 `--system-proxy`：

```sh
node apps/server/dist/auth/cli.js login --open-source-ready --system-proxy --profile-dir <独立目录>
```

工具通过 Windows 解析当前用户系统设置对官方授权地址的代理选择，在独立 Node 子进程中启用环境代理，使令牌交换和身份公钥下载使用相同配置；回环回调仍直连。不会修改系统代理、记录代理原值或关闭 TLS 校验。需要运行时支持 `--use-env-proxy`，不要求某个固定 Node 小版本；无法解析 HTTP(S) 代理或连接失败时明确报错，不自动回退直连。该选项只影响本次登录，后续运行器与云端网络须分别配置和验证。

模型子进程会保留显式配置的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`（包括对应小写名称），其他业务凭据与 API key 仍不继承。Windows 授权子进程通过 IPC 正常取消并清理登录锁。已接受的回调等待令牌交换和身份校验完成，避免普通连接的空闲超时打断成功页面；整体登录期限仍然生效。

账号、工作区及实际使用地区还须满足服务方的支持条件；选择服务器地区不能单独证明资格。授权端点的地区或权限拒绝应明确呈现，停止重复登录，按官方说明处理；错误正文与凭据不会写入诊断。

- [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart)
- [开源应用与 Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

模型、资料工具、对外发送和设备权限是独立能力。现有代码不应被当成一个已经开放 shell、邮箱或手机权限的通用执行器。

## 源码范围与重新打包

```sh
node deploy/package-release.mjs --out <全新目录>
```

输出父目录必须存在。先停止修改源码，再生成新目录；不会覆盖已有目录。工具仅复制 `deploy/release-files.json` 逐项列出的文件，既不扫描 Git，也不自动吸收新文件。

此清单声明 `scope: server-core`。打包器会额外拒绝客户端目录和美术媒体路径。根 package/lock 与核心 Dockerfile 从 `deploy/release-content` 的显式模板覆盖；所有重打包所需的模板也收录在包中。CI 模板保留在该目录，清单不生成 `.github/workflows` 下的文件。包可以在没有原开发仓库的情况下重新生成同一份载荷。

以下内容均不收录：原生与桌面客户端、社区龙娘及其他图片、APK/安装器、签名材料、真实授权和密钥、聊天数据库、设备与预算记录、个人需求文档、`AGENTS.md`、`docs`、Git 元数据、工作草稿和缓存。

为兼容既有校验流程，清单仍命名为 `REVIEW-MANIFEST.json`；其中记录源码范围、清单中显式配置的 MIT 发布设置和目标仓库，以及每个载荷文件的相对路径、字节数和 SHA-256。清单不对自身做递归哈希。它验证包内字节，不证明源码没有秘密或依赖许可证已全部审核。

工具拒绝越界路径、符号链接/目录联接、硬链接、冲突目标及已有输出目录；这些检查不替代对恶意并发写入者的系统隔离。依赖继续受各自上游许可证约束。

`deploy/release-files.json` 中的 `release` 元数据记录此次发布设置；移除该元数据时，打包器仍默认生成审阅状态的本地包。修改发布范围或第三方材料时应重新核对相应许可。打包器只生成本地目录，不上传代码、不创建远程仓库、不推送，也不激活模型授权。
