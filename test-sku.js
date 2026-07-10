const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnvFile, parse } = require('./src/cli');
const { buildServiceConfig } = require('./bin/run.js');
const { Channel } = require('./src/channel');
const { ImageUploader } = require('./src/image-uploader');
const { startMockUploadServer } = require('./src/mock-upload-server');
const { CliproxyPool } = require('./src/cliproxy-pool');

const COMMON_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-web-security',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--lang=en-GB',
];

// 代理链设置（CHAIN_PROXY 优先，否则用 CLASH_PROXY 直连）
// CHAIN_PROXY：本地 gost/proxychains 等链式代理的 HTTP 监听端口
//   链路：Crawler → gost → Clash → Cliproxy → eur.vevor.com
// CLASH_PROXY：本地 Clash 直连（无法完成 Clash→Cliproxy 链式，仅供冒烟）
function buildBrowserArgs() {
  const args = [...COMMON_BROWSER_ARGS];
  const upstream = process.env.CHAIN_PROXY || process.env.CLASH_PROXY;
  if (upstream) {
    args.push(`--proxy-server=${upstream}`);
  }
  return args;
}

function parseArgs(argv) {
  let sku = null;
  let mockUpload = false;
  const flagTokens = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mock-upload') {
      // 走本地 mock server，不是 CRAWLER_IMAGE_UPLOAD 开关，因此不交给 parse()
      mockUpload = true;
      continue;
    }
    if (arg.startsWith('--')) {
      flagTokens.push(arg);
    } else if (sku === null) {
      sku = arg;
    } else {
      // 非首位的非 flag 参数作为上一 flag 的 value
      flagTokens.push(arg);
    }
  }

  // 委托给 src/cli.js 的 parse()，做 kebab-case → camelCase 映射 + env 兜底
  const rawConfig = parse(flagTokens);
  return { sku: sku || 'GXSBSJSGWLGXVOLJBV0', rawConfig, mockUpload };
}

/**
 * 当 .env 配置了 CLIPROXY_USERNAME/PASSWORD 时，构造粘性会话并写入 config.proxy。
 * Channel._buildContextOptions() 会读取 config.proxy，从而让 Playwright 走 Cliproxy 出口。
 */
async function setupCliproxyIfNeeded(config) {
  const username = process.env.CLIPROXY_USERNAME;
  const password = process.env.CLIPROXY_PASSWORD;
  if (!username || !password) return;

  const pool = new CliproxyPool({
    host: process.env.CLIPROXY_HOST,
    port: Number(process.env.CLIPROXY_PORT),
    username,
    password,
    region: process.env.CLIPROXY_REGION || 'EU',
    asn: process.env.CLIPROXY_ASN,
    stickyMinutes: Number(process.env.CLIPROXY_STICKY_MINUTES || 30),
    sessionPrefix: process.env.CLIPROXY_SESSION_PREFIX || 'crawler',
    channels: 1,
    assignmentsFile: process.env.CLIPROXY_ASSIGNMENTS_FILE || path.resolve('./cliproxy-assignments.json'),
    regionParamName: process.env.CLIPROXY_REGION_PARAM_NAME,
    asnParamName: process.env.CLIPROXY_ASN_PARAM_NAME,
    sessionParamName: process.env.CLIPROXY_SESSION_PARAM_NAME,
    stickyParamName: process.env.CLIPROXY_STICKY_PARAM_NAME,
  });
  await pool.assign();
  const proxyUrl = pool.getProxyForChannel('ch-1');
  if (proxyUrl) {
    config.proxy = proxyUrl;
    const safe = proxyUrl.replace(/:[^:@/]+@/, ':***@');
    const chainProxy = process.env.CHAIN_PROXY;
    const clashProxy = process.env.CLASH_PROXY;
    if (chainProxy) {
      console.log(`[CLIPROXY] Assigned sticky proxy: ${safe}`);
      console.log(`[CLIPROXY] Chain mode: Browser → ${chainProxy} (gost/proxychains) → Clash → Cliproxy → eur.vevor.com`);
    } else if (clashProxy) {
      console.log(`[CLIPROXY] Assigned sticky proxy: ${safe}`);
      console.log(`[CLIPROXY] Direct mode: Browser → ${clashProxy} (Clash only, Cliproxy 直连风险存在)`);
    } else {
      console.log(`[CLIPROXY] Assigned sticky proxy: ${safe}`);
      console.log(`[CLIPROXY] WARNING: 未设置 CHAIN_PROXY / CLASH_PROXY，若机器在大陆将直接被 Cliproxy 403。`);
    }
  } else {
    console.warn('[CLIPROXY] No proxy URL assigned for ch-1');
  }
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
    args: buildBrowserArgs(),
  });
}

async function main(argv = process.argv) {
  loadEnvFile(process.cwd());

  const { sku, rawConfig, mockUpload } = parseArgs(argv);
  const config = buildServiceConfig(rawConfig);
  await setupCliproxyIfNeeded(config);

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

module.exports = { parseArgs, setupCliproxyIfNeeded, main };
