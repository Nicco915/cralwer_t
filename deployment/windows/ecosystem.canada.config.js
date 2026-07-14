const path = require('path');

const installDir = process.env.CRAWLER_INSTALL_DIR || path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// 加拿大 Windows 专用 PM2 配置（仅此一台机器使用；其它 Windows 继续用 ecosystem.config.js）
//
// 设计要点：
//  1. 每进程独立 cwd（instances/wNN）→ 自动隔离 logs/、output/browser-temp/、
//     output/cliproxy-assignments.json、output/images/。
//     避免多进程共享同一文件导致 sid/nonce 串号（temp 容器共享 output 卷踩过的坑）。
//  2. 每进程唯一 nodeCode + session prefix（w01~w05，不含 "-"）→ cliproxy 以 sid
//     第一个 "-" 前的字符串作为 session key，第一段唯一 ⇒ 出口 IP 唯一。
//  3. 双写 SESSION_PREFIX：CRAWLER_CLIPROXY_SESSION_PREFIX 优先级高于
//     CLIPROXY_SESSION_PREFIX（src/cli.js:224-225 first-match-wins），两个都必须设。
//  4. 与 VPS 硬隔离：REGION=CA + ASN=AS11290（VPS 为 DE/AS12897）。
//     未来 VPS 迁 CA 后，让 VPS 换用另一个 ASN 即可继续保持隔离。
//  5. PARAM_NAME 必须与 VPS 一致（region/asn/sid/t），否则代理 username 编码错误。
//     （VPS /opt/crawler/.env 实测值；代码默认是 country/session/sticky，不可依赖默认。）
//
// 首次部署前必须创建每进程工作目录（PM2 不会自动建 cwd）：
//   PowerShell:  1..5 | % { New-Item -ItemType Directory -Force "instances\w0$_" }
// ─────────────────────────────────────────────────────────────────────────────

// cliproxy 账号凭据：与 VPS 同一账号。真实值不要提交到 git。
// 提供方式（任选其一）：
//   a) 本机用户环境变量（推荐）：setx CLIPROXY_USERNAME "xxx" & setx CLIPROXY_PASSWORD "yyy"
//      （setx 后需重开终端 / 重启 PM2 才生效）
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

// 进程数量与起始健康端口。扩容只需改 NODE_COUNT（prefix 自动 w01..wNN）。
const NODE_COUNT = 5;
const HEALTH_PORT_BASE = 3100; // w01 -> 3101, w02 -> 3102, ...

function makeApp(i) {
  const id = 'w' + String(i).padStart(2, '0'); // w01..w05
  const cwd = path.join(installDir, 'instances', id);
  return {
    name: 'crawler-ca-' + id,
    script: path.join(installDir, 'bin', 'run.js'),
    args: '--mode=service',
    cwd,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      // 强制 Playwright 自带 Chromium，避免 Edge / Family Safety 干扰（与 stock 一致）
      CRAWLER_BROWSER_PATH: '',
      // 身份 + 单 channel（run.js:40 默认 channels=4，必须显式设为 1）
      CRAWLER_NODE_CODE: id,
      CRAWLER_CHANNELS: '1',
      // 健康端口每进程唯一（避免同机端口冲突；本机无 Blackbox，仅供手动 /health 检查）
      CRAWLER_HEALTH_PORT: String(HEALTH_PORT_BASE + i),
      // cliproxy session prefix（双写，缺一不可；值唯一且不含 "-"）
      CRAWLER_CLIPROXY_SESSION_PREFIX: id,
      CLIPROXY_SESSION_PREFIX: id,
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
  apps: Array.from({ length: NODE_COUNT }, (_, k) => makeApp(k + 1)),
};
