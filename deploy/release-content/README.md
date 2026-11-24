# 终焉服务端核心

终焉把对话、任务和事件保存在 SQLite 中。客户端断开后，服务端可以继续处理已入队的任务；重新连接时可查询原任务的进度和结果。仓库包含 HTTP 服务、独立模型运行器、共享 TypeScript 契约和部署工具。[公开仓库](https://github.com/FoxTerminus/zhongyan-core) · [MIT 许可证](LICENSE)

## 本地开发

使用 Node.js 24 或更新版本，在仓库根目录运行以下命令。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:deployment
node --test scripts/test/lab3-preferences.test.mjs
npm run build
```

运行 `npm run setup` 准备本地配置，运行 `npm run dev:server` 启动服务。模型运行器需要单独配置和授权。运行器的配置与能力见[运行器说明](apps/server/src/runtime/README.md)。

## 目录与部署

- `apps/server` 提供会话、任务恢复、资料修订、通知和模型运行器；`packages/contracts` 定义服务与客户端共用的数据格式。
- `scripts/lab3/preference-experiment.mjs` 提供训练与留出题分离、匿名 A/B 评分和结果比较。配套测试使用虚构数据，可离线运行。
- `deploy` 包含容器构建、HTTPS、健康检查、加密备份和恢复工具。网关在域名和 IP 两种模式下都对外屏蔽 `/internal/*`。启动和恢复步骤见[运维指南](deploy/operations.md)，证书配置见[HTTPS 指南](deploy/https-ip.md)。

发布内容由 `deploy/release-files.json` 逐文件指定。在根目录运行 `node deploy/package-release.mjs --out <新目录>` 可生成源码包；`REVIEW-MANIFEST.json` 列出载荷文件的大小和 SHA-256。手机和桌面客户端、私有业务集成及运行数据独立维护。
