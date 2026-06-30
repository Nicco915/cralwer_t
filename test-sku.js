const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnvFile } = require('./src/cli');
const { buildServiceConfig } = require('./bin/run.js');
const { Channel } = require('./src/channel');
const { ImageUploader } = require('./src/image-uploader');

const COMMON_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--lang=en-GB',
];

async function launchBrowser(headless, config) {
  const browserTempDir = config.browserTempDir || path.resolve(process.cwd(), 'output', 'browser-temp');
  if (!fs.existsSync(browserTempDir)) {
    fs.mkdirSync(browserTempDir, { recursive: true });
  }
  return chromium.launch({
    headless,
    executablePath: config.browserPath || undefined,
    tracesDir: browserTempDir,
    downloadsPath: browserTempDir,
    args: COMMON_BROWSER_ARGS,
  });
}

async function main() {
  loadEnvFile(process.cwd());

  const rawConfig = {};
  // 允许通过命令行覆盖简单配置，例如 --proxy=http://...
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const eqIndex = key.indexOf('=');
      if (eqIndex !== -1) {
        rawConfig[key.slice(0, eqIndex)] = key.slice(eqIndex + 1);
      }
    }
  }

  const config = buildServiceConfig(rawConfig);

  if (!fs.existsSync(config.imageDir)) {
    fs.mkdirSync(config.imageDir, { recursive: true });
  }

  const sku = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : 'GXSBSJSGWLGXVOLJBV0';
  const taskId = `test-${Date.now()}`;

  console.log(`\n=== Testing SKU: ${sku} ===`);
  console.log(`config.headedFallback: ${config.headedFallback}`);
  console.log(`config.proxy: ${config.proxy || '(none)'}`);
  console.log(`config.browserPath: ${config.browserPath || '(Playwright bundled Chromium)'}`);
  console.log('');

  const browser = await launchBrowser(true, config);

  const channel = new Channel({
    id: 1,
    config,
    log: (...args) => console.log(...args),
    headedBrowserLauncher: () => launchBrowser(false, config),
  });

  await channel.init(browser);

  try {
    const result = await channel.crawl({ crawlerTaskId: taskId, sku });
    console.log('\n=== Result ===');
    console.log(JSON.stringify({
      status: result.status,
      product_name: result.product_name,
      product_url: result.product_url,
      error: result.error,
      image_count: result.images ? result.images.length : 0,
      image_paths: result.image_paths || '',
    }, null, 2));

    if (result.status === 'success' && result.image_paths) {
      const uploadUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
      if (uploadUrl) {
        const concurrency = Number(process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY) || 2;
        const maxRetries = process.env.CRAWLER_IMAGE_UPLOAD_RETRIES !== undefined
          ? Number(process.env.CRAWLER_IMAGE_UPLOAD_RETRIES)
          : 3;
        const uploader = new ImageUploader({
          uploadUrl,
          nodeCode: config.nodeCode,
          nodeToken: config.nodeToken,
          concurrency,
          maxRetries,
        });
        console.log(`\n=== Uploading images to ${uploadUrl} ===`);
        try {
          const uploadResult = await uploader.upload(result);
          console.log(JSON.stringify(uploadResult, null, 2));
        } catch (uploadErr) {
          console.error('Image upload failed:', uploadErr.message);
        }
      } else {
        console.log('\n=== CRAWLER_IMAGE_UPLOAD_URL not set, skipping image upload ===');
      }
    }
  } catch (err) {
    console.log('\n=== Thrown error ===');
    console.error(err);
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
