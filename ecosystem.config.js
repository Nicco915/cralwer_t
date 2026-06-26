module.exports = {
  apps: [
    {
      name: 'crawler',
      script: './bin/run.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // 统一 PM2 日志时间戳格式，保证所有生产环境输出一致
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        CRAWLER_MODE: 'service',
        CRAWLER_CHANNELS: '1',
        // 强制 Playwright 使用项目目录作为临时目录，避免系统 Temp 权限问题
        TEMP: 'D:\\hs-sku-crawler\\output\\browser-temp',
        TMP: 'D:\\hs-sku-crawler\\output\\browser-temp',
        CRAWLER_BROWSER_TEMP_DIR: 'D:\\hs-sku-crawler\\output\\browser-temp',
      },
      max_restarts: 5,
      min_uptime: '10s',
    },
  ],
};
