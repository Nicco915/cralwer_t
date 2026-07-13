# 临时调度任务设计：Excel → tasks 协议派发，callback → 结果 Excel + 图片

日期：2026-07-13
状态：设计已确认，待编写实现计划

## 背景与目标

一次性临时爬取任务：5570 个 SKU（`SKU_database_01.xlsx`，Sheet1，列：`sku | 建议税号 | 建议品名`，已确认无重复 sku）。

要求：

- 任务**不**由上游正式 API 派发，结果**不**回推正式 API
- 复用现有爬虫镜像与全部爬取能力（cliproxy 代理池、多 channel 并发、健康检查、超时换 IP 重试）
- 坚决不污染正式容器与正式任务链路
- 产物：结果 Excel（原 3 列 + 爬取结果 + 图片文件名列）+ 全部图片，下载到本地

## 关键决策（已与用户确认）

1. 实现方式：全新独立 dispatcher 脚本（`scripts/temp-dispatcher/`），不修改 `src/`、`bin/`、`deployment/` 任何现有文件
2. 不 build 新镜像：dispatcher 脚本以 volume 挂进现有 `CRAWLER_IMAGE` 容器运行（镜像内已有 node 20 + exceljs）
3. 部署：bwg 单机。正式容器 `docker stop` 暂停（保留状态，跑完 `docker start` 恢复），新建 1 个 dispatcher 容器 + 8~10 个临时 crawler 容器
4. 代理：现有容器已全部使用 cliproxy，池子充足；临时容器照抄现有 `.env` 的 cliproxy 配置，无需调整分区；正式容器停止期间无池竞争
5. 失败重试：`success=false` 且 errorMessage 含 "Page shows no result" → 直接终态不重试；其他失败重试 1 次（共 2 次尝试）后落最终失败
6. 图片：全部临时 crawler 共享挂载 `/opt/hs-sku-temp/images`（图片容器内命名为 `sku_序号.ext`），跑完 tar + scp 下载
7. 结果 Excel 列：`sku | 建议税号 | 建议品名 | goodsName | goodsDesc | sourceUrl | rawContent | success | errorMessage | image_1~image_5 | crawledAt`
8. 重复 sku：输入文件已无重复；dispatcher 保留防御性检查（日志列出重复清单 + 仅首发一次任务）

## 架构

```
                         bwg VPS（单机）
┌──────────────────────────────────────────────────────────┐
│ 正式容器 ×8（docker stop 暂停，不删不改，跑完 docker start 恢复）│
├──────────────────────────────────────────────────────────┤
│ /opt/hs-sku-temp/                                        │
│  ├─ dispatcher（1 个容器，复用 CRAWLER_IMAGE，command 覆盖）│
│  │   ├─ 卷挂载 ./dispatcher 脚本目录（:ro）                │
│  │   ├─ 卷挂载 ./state（state.json + results.jsonl）      │
│  │   ├─ 卷挂载 ./SKU_database_01.xlsx（:ro）              │
│  │   └─ 卷挂载 ./images（:ro，导出时扫图片名）             │
│  │                                                        │
│  └─ crawler-temp ×8~10（同镜像，env 指向 dispatcher）      │
│      ├─ 共享挂载 /opt/hs-sku-temp/images ← 图片统一落盘    │
│      └─ 各自 logs 独立目录                                 │
└──────────────────────────────────────────────────────────┘
```

- 临时 crawler 全部 `restart: "no"`，跑完即弃
- dispatcher 端口 18080，仅 docker 网络/本机可达，不暴露公网
- 节点鉴权：nodeToken 照传但不校验（内网临时使用）

## 组件设计

`scripts/temp-dispatcher/` 五个模块：

```
scripts/temp-dispatcher/
├── index.js          # 入口：装配模块、启动 HTTP、优雅退出（SIGTERM flush）
├── task-store.js     # 任务状态机 + 持久化（核心）
├── result-writer.js  # callback → results.jsonl 追加 + 最终 Excel 导出
├── http-server.js    # 3 个端点的协议层（无业务逻辑）
└── excel-source.js   # 读 Sheet1，建 sku→{建议税号, 建议品名} 索引
```

### task-store.js（核心状态机）

状态：`pending → issued → completed`。

- `issue(limit)`：取 N 个 pending 标记 issued，返回 tasks 协议 JSON（形状对齐 `test/mock-production/mock-server.js` 的 `buildTasks`；`id` = `3070310839000000000n + index`，避开 mock/正式库 ID 段）
- `complete(taskId, success, errorMessage)`：
  - `success=true` → completed
  - `success=false` 且 errorMessage 含 "Page shows no result" → completed（不重试）
  - 其他失败且 `attempts < 2` → 退回 pending（重试 1 次）
  - 否则 → completed（最终失败，errorMessage 留档）
- **lease 回收**：issued 超过 `DISPATCHER_TASK_LEASE_MS`（默认 600000ms，远大于爬虫侧 taskTimeoutMs 130s + 换 IP 重试开销）未收到 callback → 退回 pending，防容器崩溃丢任务。由 30s 周期定时器扫描
- **持久化**：每次状态变更后 `state.json` 原子写入（tmp + rename）；启动时优先从 state.json 恢复，否则从 Excel 重建

### result-writer.js

- 每条 callback 立即 append 一行 `results.jsonl`（sku、success、errorMessage、goodsName、goodsDesc、sourceUrl、rawContent、时间戳）——真相源，Excel 随时可重建
- 追加失败 → 抛错，HTTP 层回 500，让爬虫侧 pusher 按现有逻辑重推（自带 3 次重试）
- `export()`：读 results.jsonl + excel-source 索引 + 扫描 images 目录，生成 `DISPATCHER_STATE_DIR/result.xlsx`（列见决策 7）。触发时机：全部任务 completed 自动导出 + `GET /export` 手动导出；重复触发幂等（覆盖写）

### http-server.js

- `POST /renren-api/classify/open/crawler/tasks` → task-store.issue（路径与上游一致，crawler 零适配）
- `POST /renren-api/classify/open/crawler/callback` → complete + result-writer
- `GET /stats` → 各状态计数、成功率、ETA
- `GET /export` → 手动触发导出
- JSON 解析用 json-bigint（与 poller/pusher 一致，防 taskId 精度丢失）

### excel-source.js

- exceljs 读 Sheet1，表头行定位 `sku` 列（大小写不敏感），同时读取 `建议税号`、`建议品名` 列
- 返回 sku 数组 + `Map<sku, {hsCode, productName}>`
- 防御性去重：重复 sku 仅首次出现入任务队列，全部重复项打印日志（sku + 行号）

## 数据流

```
SKU_database_01.xlsx ──excel-source──▶ task-store(pending×5570)
                                            │ issue(limit)
crawler-temp ◀────tasks 协议 JSON──── POST /tasks
     │ 爬取（cliproxy 代理池/换 IP/超时重试，全部沿用现有逻辑）
     │ callback {crawlerTaskId, sku, goodsName, goodsDesc,
     │           sourceUrl, rawContent, success, errorMessage}
     ▼
POST /callback ──▶ task-store.complete（状态 + 重试判定）
               └─▶ result-writer ──▶ results.jsonl（追加，真相源）
图片：crawler 容器内直接写共享卷 /opt/hs-sku-temp/images/sku_1.jpg
收尾：全部 completed 自动导出 result.xlsx；tar images + xlsx → scp 本地
```

## 错误处理

| 场景 | 处理 |
|---|---|
| crawler 容器崩溃/重启 | 任务卡 issued，lease 过期自动退回 pending，其他容器接走 |
| dispatcher 重启 | state.json + results.jsonl 恢复；issued 任务走 lease 回收 |
| callback 重复到达 | taskId 已 completed → 回 200，jsonl 记 duplicate 标记，不影响统计 |
| callback taskId 不存在 | 回 200 + orphan 日志（不 5xx，避免爬虫无限重推） |
| 单 SKU 连续失败 | 重试 1 次后落最终失败入结果表，不阻塞全局 |
| 某 sku 无图 | 导出时 image 列留空 |
| 磁盘满/写失败 | jsonl 追加失败 → callback 回 500，爬虫 pusher 重推 |
| Excel 重复 sku | 日志列清单 + 仅首发一次（输入文件已确认无重复，纯防御） |

## 部署与运行手册

目录结构（全部在 `/opt/hs-sku-temp/`，跑完整体删除）：

```
/opt/hs-sku-temp/
├── dispatcher/              # scripts/temp-dispatcher/ 内容
├── SKU_database_01.xlsx     # scp 上传
├── state/                   # state.json + results.jsonl + result.xlsx
├── images/                  # 8~10 个 crawler 共享挂载
├── node-1/logs ... node-10/logs
├── dispatcher.compose.yml
└── crawler.compose.yml
```

dispatcher 容器关键配置：

```yaml
services:
  dispatcher:
    image: ${CRAWLER_IMAGE}            # 与正式容器同一 tag，不 build
    container_name: hs-sku-dispatcher
    restart: unless-stopped
    command: ["node", "/app/temp-dispatcher/index.js"]
    ports: ["127.0.0.1:18080:18080"]
    volumes:
      - ./dispatcher:/app/temp-dispatcher:ro
      - ./SKU_database_01.xlsx:/data/SKU_database_01.xlsx:ro
      - ./state:/data/state
      - ./images:/data/images:ro
    environment:
      - DISPATCHER_PORT=18080
      - DISPATCHER_EXCEL=/data/SKU_database_01.xlsx
      - DISPATCHER_SHEET=Sheet1
      - DISPATCHER_STATE_DIR=/data/state
      - DISPATCHER_IMAGES_DIR=/data/images
      - DISPATCHER_TASK_LEASE_MS=600000
```

crawler 临时容器：复制 `deployment/linux/docker-compose.yml`，仅改 4 处——

1. `container_name: hs-sku-temp-${N}`
2. `restart: "no"`
3. env：`CRAWLER_TASK_URL=http://172.17.0.1:18080/renren-api/classify/open/crawler/tasks`、`CRAWLER_CALLBACK_URL=.../callback`
4. images 卷改为共享 `/opt/hs-sku-temp/images`

cliproxy 配置与 channels 数照抄现有 `.env`。

运行流程：

1. `docker stop` 全部正式容器 → 释放内存与 cliproxy 会话
2. `docker compose -f dispatcher.compose.yml up -d` → `curl 127.0.0.1:18080/stats` 确认 totalTasks=5570
3. `docker compose -f crawler.compose.yml up -d`
4. 监控：`/stats` + loki（临时容器日志标签独立，不混正式）
5. 完成判定：`completedCount == totalTasks`，dispatcher 自动导出 `state/result.xlsx`
6. 收尾：`tar czf images.tar.gz images/` + scp result.xlsx/images.tar.gz 回本地 → `docker compose down -v` ×2 + `rm -rf /opt/hs-sku-temp`
7. `docker start` 全部正式容器 → 正式任务恢复

## 测试策略

TDD，沿用仓库现有约定（`node --test`、CommonJS、每个模块一个测试文件），放 `test/temp-dispatcher/`：

| 测试文件 | 覆盖 |
|---|---|
| `excel-source.test.js` | 表头定位（大小写）、税号/品名读取、空行跳过、重复 sku 去重 + 日志、sheet 不存在报错 |
| `task-store.test.js` | issue 顺序/限量、complete 四分支（成功/no result 不重试/失败重试 1 次/二次失败终态）、lease 过期回收、state.json 原子写与重启恢复、重复 complete 幂等 |
| `result-writer.test.js` | jsonl 追加格式、磁盘错误传播、export 列齐全 + 税号/品名 join + 图片名扫描（有图/无图/部分图）、多次 export 幂等 |
| `http-server.test.js` | 起真实端口：tasks 协议形状（对齐上游）、callback→completed、BigInt taskId 精度、/stats、/export；用 `src/poller.js` + `src/pusher.js` 真实客户端各打一个端到端回合 |

集成验证（手动，bwg 实跑前）：

1. 本地 docker 起 dispatcher + 1 个 crawler（`--test-count` 等效：用 10 行小 Excel）
2. 跑通「派发 → 爬取 → callback → jsonl → 导出 xlsx + 图片」全链路
3. 中途 `docker restart` dispatcher，验证 state 恢复与 lease 回收
4. 验证正式容器全程未受影响（env、日志、状态）

## 刻意不做（YAGNI）

- 不做节点鉴权校验、不做任务优先级/限速（pollLimit + channels 天然限速）
- 不做 dashboard UI（/stats JSON 足够）
- 不做多 Excel/多批次管理（一次性任务）
- 不改 batch CLI 模式、不改 mock-server（本方案与其并存，互不影响）
