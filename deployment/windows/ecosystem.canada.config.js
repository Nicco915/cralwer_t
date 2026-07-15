const fs = require('fs');
const path = require('path');

const installDir = process.env.CRAWLER_INSTALL_DIR || path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// 加拿大 Windows 专用 PM2 配置（仅此一台机器使用；其它 Windows 继续用 ecosystem.config.js + .env）
//
// 与其它 Windows 机器的差异：
//   其它机器单进程，用 .env 设一个 CRAWLER_NODE_CODE 即可。
//   本机多进程，每个进程要不同的 nodeCode，单个 .env 放不下，所以这里用
//   NODE_CODES 数组逐个手填（命名约定保持一致，如 crawler-15）。
//
// 设计要点：
//  1. nodeCode 与 sessionPrefix 解耦：nodeCode 随便起（可带 "-"）；
//     sessionPrefix 由代码自动从 nodeCode 派生（去掉所有 "-"），保证无 "-"。
//     原因：cliproxy 以 sid 第一个 "-" 前的字符串作为 session key，prefix 含 "-"
//     会被截断（crawler-15 -> crawler），多进程撞同一出口 IP（VPS 踩过的坑）。
//  2. 每进程独立 cwd（instances/<nodeCode>）→ 自动隔离 logs/、output/browser-temp/、
//     output/cliproxy-assignments.json、output/images/。目录在 PM2 加载本配置时自动创建。
//  3. 双写 SESSION_PREFIX（CRAWLER_CLIPROXY_SESSION_PREFIX 优先级更高，两个都必须设）。
//  4. 与 VPS 硬隔离：REGION=CA + ASN=AS11290（VPS 为 DE/AS12897）。
//  5. PARAM_NAME 必须与 VPS 一致（region/asn/sid/t），否则代理 username 编码错误。
// ─────────────────────────────────────────────────────────────────────────────

// cliproxy 账号凭据：与 VPS 同一账号。真实值不要提交到 git。
// 提供方式（任选其一）：
//   a) 本机用户环境变量（推荐）：setx CLIPROXY_USERNAME "xxx" & setx CLIPROXY_PASSWORD "yyy"
//   b) 直接把下面 '' 改成真实值（本机私有，改完勿提交）
const CLIPROXY_USERNAME = process.env.CLIPROXY_USERNAME || '';
const CLIPROXY_PASSWORD = process.env.CLIPROXY_PASSWORD || '';

// 所有进程共享的 cliproxy 配置（host/port/region/asn/param 名与 VPS 对齐）
const SHARED_PROXY = {
  CLIPROXY_HOST: 'us2.cliproxy.io',
  CLIPROXY_PORT: '3010',
  CLIPROXY_REGION: 'CA',
  CLIPROXY_ASN: 'AS11290',
  CLIPROXY_STICKY_MINUTES: '10',
  CLIPROXY_REGION_PARAM_NAME: 'region',
  CLIPROXY_ASN_PARAM_NAME: 'asn',
  CLIPROXY_SESSION_PARAM_NAME: 'sid',
  CLIPROXY_STICKY_PARAM_NAME: 't',
  CLIPROXY_USERNAME,
  CLIPROXY_PASSWORD,
};

// ─────────────────────────────────────────────────────────────────────────────
// ★ 在这里手动维护每台爬虫的 nodeCode（每行一个，可带 "-"，与其它 Windows 机器同一命名）。
//   把下面 5 个换成你实际的 nodeCode。增删进程 = 增删这里的行。
//   sessionPrefix 由代码自动派生（去 "-"），无需手填。
// ─────────────────────────────────────────────────────────────────────────────
const NODE_CODES = [
  'crawler-13',
  'crawler-14',
  'crawler-15',
  'crawler-16',
  'crawler-17',
];

const HEALTH_PORT_BASE = 3100; // 第 1 个进程 -> 3101，依此类推

// sessionPrefix = nodeCode 去掉所有 "-"。crawler-15 -> crawler15。
// 无 "-" => cliproxy 第一段唯一 => 每进程独立出口 IP。
function toSessionPrefix(nodeCode) {
  return nodeCode.replace(/-/g, '');
}

// 防呆：派生出的 sessionPrefix 必须两两唯一，否则在 PM2 加载阶段直接报错，
// 而不是静默撞 IP（如 "crawler-15" 与 "crawler1-5" 去 "-" 后都是 "crawler15"）。
(function assertUniqueSessionPrefixes() {
  const seen = new Map();
  for (const nc of NODE_CODES) {
    const p = toSessionPrefix(nc);
    if (seen.has(p)) {
      throw new Error(
        '[ecosystem.canada] sessionPrefix 冲突："' + seen.get(p) + '" 与 "' + nc +
        '" 去掉 "-" 后都是 "' + p + '"。请调整 nodeCode 使去 "-" 后唯一。'
      );
    }
    seen.set(p, nc);
  }
})();

function makeApp(nodeCode, index) {
  const prefix = toSessionPrefix(nodeCode);                 // 无 "-"，仅用于 cliproxy session
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
      // 任务端节点名：你手填的 nodeCode（可带 "-"）
      CRAWLER_NODE_CODE: nodeCode,
      // 单 channel（run.js:40 默认 channels=4，必须显式设为 1）
      CRAWLER_CHANNELS: '1',
      // 健康端口每进程唯一（避免同机端口冲突；本机无 Blackbox，仅供手动 /health 检查）
      CRAWLER_HEALTH_PORT: String(HEALTH_PORT_BASE + index),
      // cliproxy session prefix：自动派生（无 "-"），双写缺一不可
      CRAWLER_CLIPROXY_SESSION_PREFIX: prefix,
      CLIPROXY_SESSION_PREFIX: prefix,
      // 共享代理配置
      ...SHARED_PROXY,
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
