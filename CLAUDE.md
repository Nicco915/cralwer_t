# VEVOR SKU 爬虫

从 VEVOR 站点抓取 SKU 商品信息（名称、描述、规格、图片），通过上游 API 拉取任务、回调上报结果的服务型爬虫。

> 完整的架构、任务流、代理体系、部署拓扑与已知雷区见 **`docs/项目全貌.md`**。

## 运行模式

- **service 模式**（主要生产模式）：`CRAWLER_MODE=service node bin/run.js` — 轮询上游任务 API，多 Channel 并发抓取，结果回调上报，图片单独上传。
- **cli 模式**：`node bin/run.js --input SKU_List.xlsx --output ./output` — 读 Excel 批量抓取，支持断点续传、中文翻译。
- **图片补传**：`node bin/transfer-images.js --dir=...` — 独立脚本，把已有图片批量上传到上游，支持断点续传。

## 常用命令

```bash
npm test                    # 单元/集成测试（node:test）
npm run service             # service 模式启动
npm run test:load           # 本地 stub 压测
node test-sku.js <sku>      # 单 SKU 调试
```

## 代码结构

| 文件 | 职责 |
|------|------|
| `src/service.js` | service 模式编排：浏览器、代理池、Channel 管理、崩溃恢复、心跳 |
| `src/worker.js` | 任务分发到 Channel，结果推送，图片上传触发 |
| `src/channel.js` | 浏览器上下文生命周期、健康检查、headed 回退、代理轮换 |
| `src/page-crawler.js` | 单 SKU 页面抓取：URL 编码、dataLayer/HTML 提取、SKU 校验、图片下载 |
| `src/poller.js` / `src/pusher.js` | 上游拉任务 / 回调上报 |
| `src/cliproxy-pool.js` | Cliproxy 住宅代理池（一爬虫一 ASN） |
| `src/region-registry.js` | 多区域站点映射（EU/US/GB/CA 等） |
| `src/image-uploader.js` | 图片上传 |
| `src/crawler.js` | cli Excel 模式编排 + 翻译（仅 cli 模式用） |
| `src/cli.js` | 配置解析（CLI flag > env > 默认） |

## 关键约定

- **SKU 含 `-`**：搜索 URL 中 `-` 编码为 `%2D`（`encodeSkuForSearchPath`），其余位置保留原始 SKU。
- **SKU 含 `/`**：用 `%2F` 编码，与 vevor 图片 URL 约定一致；注意含 `/` 的 SKU 会截断搜索路由导致 dataLayer 误报（已知边界）。
- **图片文件名**：`<sku>_<index>.<ext>`，SKU 从文件名推断时去掉末尾 `_数字.扩展名`。
- **配置优先级**：CLI flag > 环境变量 > 默认值（见 `src/cli.js`）。
- **日志**：`src/logger.js` 输出 NDJSON（BigInt 需安全序列化），Loki + Promtail + Grafana 统一监控。`crawler.jsonl` 按 `CRAWLER_LOG_MAX_SIZE_MB`（默认 50MB）轮转为 `crawler-YYYYMMDD-HHMMSS.jsonl`，与 `logs/callbacks/` 一起按 `CRAWLER_LOG_RETENTION_DAYS`（默认 7 天）清理；PM2 托管日志（crawler-combined/out/error-*.log）由 `deployment/windows/setup-pm2-logrotate.ps1` 配置的 pm2-logrotate 轮转。
- **代理**：静态代理 `CRAWLER_PROXY` 与 Cliproxy 池互斥，静态优先级更高；`CRAWLER_CHANNELS` 不能超过本机分到的 IP 数；Channel-IP 映射持久化到 `CLIPROXY_ASSIGNMENTS_FILE`。

## 部署

- **海外 VPS（Linux + Docker）**：`deployment/linux/`，8 个独立容器，CI deploy 会误建重复的 `hs-sku-crawler` 容器，发版后需删除。
- **Windows**：`scripts/deploy/windows/`（Docker Desktop 或原生 PowerShell + PM2），bondex 节点用本地 Edge。
- 详见 `README.md`、`部署vps.md`、`readme_docker_*.md`。

## 测试约定

- 测试框架：`node:test`（无 jest/mocha），测试文件在 `test/` 与 src 模块一一对应。
- `test/mock-production/`（mock 上游服务器/仪表盘测试）不在 `npm test` 默认套件内，用 `npm run test:mock` 单独跑。
- 改动某模块后至少跑对应测试文件：`node --test test/<name>.test.js`。
- 声称完成前必须实际运行验证命令，用输出佐证。

## 沟通约定

- 使用中文交流。
