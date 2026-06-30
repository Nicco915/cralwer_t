const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnvFile } = require('./src/cli');
const { buildServiceConfig } = require('./bin/run.js');
const { Channel } = require('./src/channel');
const { ImageUploader } = require('./src/image-uploader');
const { startMockUploadServer } = require('./src/mock-upload-server');

const COMMON_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--lang=en-GB',
];

function parseArgs(argv) {
  const rawConfig = {};
  let sku = null;
  let mockUpload = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const eqIndex = key.indexOf('=');
      if (eqIndex !== -1) {
        rawConfig[key.slice(0, eqIndex)] = key.slice(eqIndex + 1);
      } else if (key === 'mock-upload') {
        mockUpload = true;
      }
    } else if (sku === null) {
      sku = arg;
    }
  }

  return { sku: sku || 'GXSBSJSGWLGXVOLJBV0', rawConfig, mockUpload };
}

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

async function main(argv = process.argv) {
  loadEnvFile(process.cwd());

  const { sku, rawConfig, mockUpload } = parseArgs(argv);
  const config = buildServiceConfig(rawConfig);

  let mockServer = null;
  if (mockUpload) {
    mockServer = await startMockUploadServer();
    process.env.CRAWLER_IMAGE_UPLOAD_URL = mockServer.url;
    console.log(`[MOCK_UPLOAD] Started mock upload server at ${mockServer.url}`);
  }

  if (!fs.existsSync(config.imageDir)) {
    fs.mkdirSync(config.imageDir, { recursive: true });
  }

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
      const uploadUrl = config.imageUploadUrl || process.env.CRAWLER_IMAGE_UPLOAD_URL;
      if (uploadUrl) {
        const concurrency = config.imageUploadConcurrency !== undefined
          ? config.imageUploadConcurrency
          : (Number(process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY) || 2);
        const maxRetries = config.imageUploadRetries !== undefined
          ? config.imageUploadRetries
          : (process.env.CRAWLER_IMAGE_UPLOAD_RETRIES !== undefined
            ? Number(process.env.CRAWLER_IMAGE_UPLOAD_RETRIES)
            : 3);
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
    if (mockServer) {
      mockServer.close();
    }
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
