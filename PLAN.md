# VEVOR 爬虫子项目计划（可复用版）

## 任务目标
从 VEVOR 站点爬取指定 Excel 中 SKU 列表的商品信息，支持正序/倒序，支持由外部大项目以子进程或模块方式调用。

## 输出字段
| 字段 | 说明 |
|------|------|
| sku | SKU 编码 |
| product_name | 商品名称 |
| features_details | Features & Details 内容 |
| product_specification | Product Specification 内容 |
| image_1 ~ image_5 | 图片本地路径（逗号分隔） |
| status | 状态 (success/not_found/error/success_translate_error) |
| product_url | 商品页 URL |
| error | 错误信息 |
| product_name_cn | 商品名称中文翻译 |
| features_details_cn | Features & Details 中文翻译 |
| product_specification_cn | Product Specification 中文翻译 |

## 技术方案

### 1. 环境
- **运行时**: Node.js + Playwright
- **浏览器**: 优先系统 Edge，找不到则回退到 Playwright 自带 Chromium
- **依赖**: `playwright`, `exceljs`
- **可选**: 配置 `DASHSCOPE_API_KEY` 后启用中译；不配置则跳过翻译

### 2. 反爬措施
- User-Agent: Edge 120 on Windows 10
- Viewport: 1920x1080
- Locale: en-GB, Timezone: Europe/London
- 请求间隔: 5-10 秒随机（可配置）
- 单进程顺序爬取

### 3. 数据提取策略

#### 搜索页 -> 商品 URL
1. **Primary**: 从 `window.dataLayer` 提取 `search.goods_list_params[sku].goodsUrl`
2. **Fallback**: HTML 正则匹配 SKU 附近的 `"goodsUrl":"..."`

#### 商品页 -> 内容
| 字段 | CSS 选择器 | 格式 |
|------|-----------|------|
| product_name | `h1` | 文本 |
| features_details | `.DM_features_details` 内的 `p, li` | 多行文本 |
| product_specification | `.DM_product_specification` / `.DM_aboutThisItem` | "Key: Value" 格式 |
| images | `img[data-src*="goods_img"]` 或 `img[data-src*="original_img"]` | 下载到本地 |

#### 图片提取
- 必须检查 `data-src` 属性（懒加载）
- 排除 `thumb` 缩略图和 `adsimg` 广告图
- 每个 SKU 最多下载 5 张（可配置）

### 4. 断点续传
- 检查点文件: 默认 `{output}/checkpoint.json`
- 输出 Excel: 默认 `{output}/vevor_result.xlsx`
- 支持 Ctrl+C 中断后恢复

## 已创建文件
| 文件 | 说明 |
|------|------|
| `src/crawler.js` | 可复用核心模块，导出 `run(config)` |
| `src/cli.js` | CLI 参数/环境变量解析 |
| `bin/run.js` | 生产入口 |
| `bin/run-test.js` | 测试入口（默认 10 个 SKU） |
| `package.json` / `package-lock.json` | 依赖声明 |
| `PLAN.md` | 本文档 |

## 执行命令

```bash
cd /Users/nz/Downloads/hs_sku/crawler
npm ci
node bin/run.js --input /path/to/SKU_List.xlsx --output /path/to/output
```

测试模式：

```bash
node bin/run-test.js --input /path/to/SKU_List.xlsx --output /path/to/output --test-count 3
```

## 常用配置

可通过 CLI 参数或环境变量传入：

| CLI 参数 | 环境变量 | 默认值 |
|----------|----------|--------|
| `--input` | `CRAWLER_INPUT` | - |
| `--output` | `CRAWLER_OUTPUT` | `./output` |
| `--image-dir` | `CRAWLER_IMAGE_DIR` | `{output}/images` |
| `--checkpoint` | `CRAWLER_CHECKPOINT` | `{output}/checkpoint.json` |
| `--result` | `CRAWLER_RESULT` | `{output}/vevor_result.xlsx` |
| `--base-url` | `CRAWLER_BASE_URL` | `https://eur.vevor.com` |
| `--order` | `CRAWLER_ORDER` | `forward` |
| `--headless` | `CRAWLER_HEADLESS` | `true` |
| `--browser-path` | `CRAWLER_BROWSER_PATH` | 自动检测 |
| `--min-delay` / `--max-delay` | `CRAWLER_MIN_DELAY` / `CRAWLER_MAX_DELAY` | 5 / 10 |
| `--flush-interval` | `CRAWLER_FLUSH_INTERVAL` | 10（测试模式 3） |
| `--translate` | `CRAWLER_TRANSLATE` | `true` |
| `--no-translate` | - | 禁用翻译 |
| `--feishu` | `CRAWLER_FEISHU` | `false` |
| `--test-count` | `CRAWLER_TEST_COUNT` | 10（仅测试入口） |

密钥通过环境变量读取：
- `DASHSCOPE_API_KEY`：DashScope 翻译 API 密钥

## 运行监控

查看当前进度（检查点）：
```bash
cat /path/to/output/checkpoint.json
```

查看已完成的文件：
```bash
ls -lh /path/to/output
```

## 其他注意事项
1. 耗时取决于 SKU 数量、网络状况、图片下载量及 Cloudflare 等待时间
2. 建议分批次运行，或夜间挂机
3. 图片下载可能因网络问题失败，不影响其他字段
4. 输出目录、检查点文件、结果文件均可通过参数指定，方便接入大项目
