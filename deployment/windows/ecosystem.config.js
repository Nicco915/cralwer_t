const path = require('path');

const installDir = process.env.CRAWLER_INSTALL_DIR || path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'crawler',
      script: path.join(installDir, 'bin', 'run.js'),
      args: '--mode=service',
      cwd: installDir,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // 强制使用 Playwright 自带的 Chromium，避免 Edge/Microsoft Family Safety 干扰
        CRAWLER_BROWSER_PATH: '',
        CRAWLER_IDLE_RECLAIM_MS: process.env.CRAWLER_IDLE_RECLAIM_MS || '300000',
        CRAWLER_IDLE_REAP_INTERVAL_MS: process.env.CRAWLER_IDLE_REAP_INTERVAL_MS || '30000',
      },
      log_file: path.join(installDir, 'logs', 'crawler-combined.log'),
      out_file: path.join(installDir, 'logs', 'crawler-out.log'),
      error_file: path.join(installDir, 'logs', 'crawler-error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: false,
      max_restarts: 10,
      min_uptime: '10s',
      autorestart: true,
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
};
