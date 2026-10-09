const fs = require('fs');
const path = require('path');

const installDir = process.env.CRAWLER_INSTALL_DIR || path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// 国内 Windows 机器「双爬虫（原生 IP 直连）」PM2 配置模板
//
// 适用场景：国内 Windows 机器，原生国内 IP 直连 VEVOR（不走任何代理），
//   每台机器跑 2 个爬虫进程。单进程机器继续用根目录 ecosystem.config.js + .env。
//
// 与单进程（ecosystem.config.js + 根目录 .env）的差异：
//   单进程时 .env 设一个 CRAWLER_NODE_CODE 即可；双进程每进程要不同 nodeCode，
//   单个 .env 放不下，所以这里用 NODE_CODES 数组逐个机器手填（见下方）。
//
// 设计要点：
//  1. 每进程独立 cwd（instances/<nodeCode>）→ 自动隔离 logs/、output/、
//     browser-temp/，两进程互不踩文件。目录在 PM2 加载本配置时自动创建，
//     无需手动 mkdir（目录不存在 PM2 会 ENOENT 起不来）。
//  2. 副作用：根目录 .env 不会被加载（cli.js 从 process.cwd() 读 .env，
//     找不到就静默跳过），所有 env 必须在本文件显式注入——尤其
//     CRAWLER_TASK_URL / CRAWLER_CALLBACK_URL / CRAWLER_IMAGE_UPLOAD_URL /
//     CRAWLER_NODE_TOKEN（见 SHARED_UPSTREAM），不配则进程回落到代码默认
//     taskUrl（错误的上游），表现为"上游查不到心跳"；IMAGE_UPLOAD_URL 缺失更
//     隐蔽：任务照跑、回调照发但照片永不上传且无报错。
//  3. nodeCode 全网唯一：两台机器的 NODE_CODES 不能重复，否则上游任务端
//     心跳/节点归属混乱。本模板不用 cliproxy，nodeCode 可以带 "-"（不像
//     canada 配置有 sessionPrefix 去 "-" 的坑），但建议同一机器两个进程用
//     统一后缀区分，如 crawler-21 / crawler-21b。
//  4. 健康检查端口每进程唯一（3101/3102）：同机两进程共用同一端口会
//     EADDRINUSE，后起的进程健康服务起不来。
//  5. 原生 IP 直连、无双 IP 自愈能力：两进程共用同一个原生出口 IP，任一进程
//     被 CF 风控时没有备用 IP 可换（canada/VPS 有代理池可轮换）。日常靠
//     Grafana 的失败率/CF 挑战率告警监控，异常时人工介入（降速/重启/换时段）。
//  6. 完全不出现任何代理配置（无 CLIPROXY_*、无 CRAWLER_PROXY、无 ASN/
//     sessionPrefix）——原生 IP 直连，配了反而会被静态代理逻辑拦截。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ★ 上游任务/回调地址：必须与 VPS 及其他 Windows 机器一致（值照抄 canada 配置）。
//   必须显式写在这里——每进程 cwd 是 instances/<nodeCode>，根目录 .env 根本
//   不会被加载（见头部设计要点 2）。
// ─────────────────────────────────────────────────────────────────────────────
const SHARED_UPSTREAM = {
  CRAWLER_TASK_URL: 'http://47.92.233.36:8003/renren-api/classify/open/crawler/tasks',
  CRAWLER_CALLBACK_URL: 'http://47.92.233.36:8003/renren-api/classify/open/crawler/callback',
  // 图片上传地址：不配则代码默认为空串，service.js 门控直接不创建 uploader，
  // 任务照跑、回调照发但照片永不上传，且无任何报错（比 TASK_URL 缺失更隐蔽）。
  CRAWLER_IMAGE_UPLOAD_URL: 'http://47.92.233.36:8003/renren-api/classify/open/image/upload',
  // 上传并发/重试用代码默认值 2/3，与 VPS 一致，无需显式注入
  CRAWLER_NODE_TOKEN: '',
};

// 显式声明区域映射（与内置默认一致；内置 US 默认启用见 region-registry.js）。
// 本机每进程独立 cwd，根目录 .env 不会被加载，因此必须在此显式注入。
// 若未来 BUILT_IN_REGIONS 新增区域或改 URL，需同步更新此处。
const SHARED_REGIONS = {
  CRAWLER_REGIONS: 'EU=https://eur.vevor.com,GB=https://www.vevor.co.uk,CA=https://www.vevor.ca,US=https://www.vevor.com',
  CRAWLER_DEFAULT_REGION: 'EU',
};

// ─────────────────────────────────────────────────────────────────────────────
// ★ 在这里手填本台机器的两个 nodeCode（每行一个，恰好 2 个，可带 "-"）。
//   命名约定：与其它 Windows 机器同一风格；同一机器第二个进程加后缀区分，
//   如 crawler-21 / crawler-21b。★ 两台机器的 nodeCode 不能重复 ★
//   增删进程 = 增删这里的行（但本模板定位就是每台 2 个，请勿超过 2 个——
//   两个进程已共享同一原生 IP，再多只会加剧 CF 风控）。
// ─────────────────────────────────────────────────────────────────────────────
const NODE_CODES = [
  'crawler-21',
  'crawler-21b',
];

const HEALTH_PORT_BASE = 3100; // 第 1 个进程 -> 3101，第 2 个 -> 3102

// 防呆：nodeCode 必须两两唯一，否则在 PM2 加载阶段直接报错，
// 而不是静默撞实例目录/健康端口（同机两个进程共用一个 cwd 会互相踩文件）。
(function assertUniqueNodeCodes() {
  const seen = new Set();
  for (const nc of NODE_CODES) {
    if (seen.has(nc)) {
      throw new Error('[ecosystem.local-dual] nodeCode 重复："' + nc + '"。每台机器两个进程必须用不同 nodeCode。');
    }
    seen.add(nc);
  }
})();

function makeApp(nodeCode, index) {
  const cwd = path.join(installDir, 'instances', nodeCode); // 以 nodeCode 建目录，便于按节点名查找
  // PM2 加载本配置时自动创建实例目录（免去手动 mkdir；目录不存在 PM2 会 ENOENT 起不来）
  fs.mkdirSync(cwd, { recursive: true });
  return {
    name: nodeCode, // pm2 list 直接显示节点名，与任务端一致
    script: path.join(installDir, 'bin', 'run.js'),
    args: '--mode=service',
    cwd,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      // 强制 Playwright 自带 Chromium，避免 Edge / Family Safety 干扰（与 stock 一致）
      CRAWLER_BROWSER_PATH: '',
      // 浏览器安装到项目目录下（两进程共享一份），避免 Windows 服务账户无法访问用户 profile
      PLAYWRIGHT_BROWSERS_PATH: path.join(installDir, 'playwright-browsers'),
      // 任务端节点名：你手填的 nodeCode（可带 "-"）
      CRAWLER_NODE_CODE: nodeCode,
      // 单 channel（run.js:40 默认 channels=4，必须显式设为 1）。
      // 两进程共享同一原生 IP，每进程 1 channel = 同 IP 峰值并发 2，
      // 与原先单进程默认 4 channel 相比反而更温和；如需提速可自行调高，
      // 但注意同 IP 并发越高 CF 挑战越多。
      CRAWLER_CHANNELS: '1',
      // 健康端口每进程唯一（同机两进程共用端口会 EADDRINUSE；仅供手动 /health 检查）
      CRAWLER_HEALTH_PORT: String(HEALTH_PORT_BASE + index),
      // 上游任务/回调地址（根目录 .env 不会被加载，必须显式注入）
      ...SHARED_UPSTREAM,
      ...SHARED_REGIONS,
      // 与 stock 对齐的空闲回收参数
      CRAWLER_IDLE_RECLAIM_MS: process.env.CRAWLER_IDLE_RECLAIM_MS || '300000',
      CRAWLER_IDLE_REAP_INTERVAL_MS: process.env.CRAWLER_IDLE_REAP_INTERVAL_MS || '30000',
    },
    // PM2 自身日志放在各进程实例目录内，与应用内 crawler.jsonl 同目录但不同文件
    log_file: path.join(cwd, 'logs', 'pm2-combined.log'),
    out_file: path.join(cwd, 'logs', 'pm2-out.log'),
    error_file: path.join(cwd, 'logs', 'pm2-error.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: false,
    max_restarts: 10,
    min_uptime: '10s',
    autorestart: true,
    kill_timeout: 30000,
    listen_timeout: 10000,
  };
}

module.exports = {
  apps: NODE_CODES.map((nodeCode, k) => makeApp(nodeCode, k + 1)),
};
