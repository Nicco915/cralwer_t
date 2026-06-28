const path = require('path');

const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: 'crawler',
      script: path.join(cwd, 'bin', 'run.js'),
      args: '--mode=service',
      cwd,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // 强制使用 Playwright 自带的 Chromium，避免 Edge/Microsoft Family Safety 干扰
        CRAWLER_BROWSER_PATH: '',
        // 浏览器安装到项目目录下，避免 Windows 服务账户无法访问用户 profile
        PLAYWRIGHT_BROWSERS_PATH: path.join(cwd, 'playwright-browsers'),
      },
      log_file: path.join(cwd, 'logs', 'crawler-combined.log'),
      out_file: path.join(cwd, 'logs', 'crawler-out.log'),
      error_file: path.join(cwd, 'logs', 'crawler-error.log'),
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
