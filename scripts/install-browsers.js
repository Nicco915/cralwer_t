const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// 把 Playwright 浏览器固定安装到项目目录下，避免 Windows 服务账户（LOCAL SERVICE）
// 无法访问当前用户 profile 里的 ms-playwright 目录。
const browsersDir = path.resolve(__dirname, '..', 'playwright-browsers');
if (!fs.existsSync(browsersDir)) {
  fs.mkdirSync(browsersDir, { recursive: true });
}
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;

console.log(`[install-browsers] Installing Playwright browsers to ${browsersDir}`);

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'install', 'chromium', 'chromium-headless-shell'],
  {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  }
);

process.exit(result.status ?? 0);
