const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_CONFIG = {
  baseUrl: 'https://eur.vevor.com',
  imageDir: './output/images',
  diagnosticDir: process.env.CRAWLER_DIAGNOSTIC_DIR || '',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  maxImages: 5,
  cloudflareMaxWait: 45,
  minDelay: 0,
  maxDelay: 0,
};

function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

function encodeSkuForSearchPath(sku) {
  // Vevor 将搜索路径中的连字符（-）视为分词符，会把 PQFJYNF-250-2T001V7
  // 拆成多个词返回泛匹配结果。将连字符编码为 %2D 后服务端会按完整 SKU 精确搜索。
  return sku.replace(/-/g, '%2D');
}

class PageCrawler {
  constructor(options) {
    this.config = resolveConfig(options);
    this.userAgent = this.config.userAgent;
    this.gotoMaxRetries = options?.gotoMaxRetries !== undefined ? options.gotoMaxRetries : 1;
    this.gotoTimeout = options?.gotoTimeout !== undefined ? options.gotoTimeout : 30000;
    this.gotoRetryDelays = options?.gotoRetryDelays || [3000, 6000, 12000];
    this.dataLayerMaxRetries = options?.dataLayerMaxRetries !== undefined ? options.dataLayerMaxRetries : 1;
  }

  log(...args) {
    console.log(...args);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  randomDelay() {
    const { minDelay, maxDelay } = this.config;
    return Math.floor(minDelay * 1000 + Math.random() * (maxDelay - minDelay) * 1000);
  }

  downloadImage(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { headers: { 'User-Agent': this.userAgent } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.downloadImage(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => reject(new Error('timeout')));
    });
  }

  async isCloudflareChallenge(page) {
    try {
      const title = await page.title().catch(() => '');
      const content = await page.content().catch(() => '');
      const url = page.url();
      const indicators = [
        'Just a moment', 'Attention Required', 'Cloudflare', 'cf-browser-verification',
        'challenge-platform', 'Turnstile', 'Ray ID', 'Please enable cookies', 'One more step',
      ];
      const lowerTitle = (title || '').toLowerCase();
      const lowerContent = (content || '').toLowerCase();
      if (indicators.some(x => lowerTitle.includes(x.toLowerCase()))) return true;
      if (indicators.some(x => lowerContent.includes(x.toLowerCase()))) return true;
      if (url.includes('/cdn-cgi/') || url.includes('__cf_chl_jschl_tk__')) return true;
      return false;
    } catch (e) {
      this.log(`[CF_CHECK] Error: ${e.message}`);
      return false;
    }
  }

  async waitForCloudflare(page, sku) {
    const { cloudflareMaxWait } = this.config;
    this.log(`[${sku}] Cloudflare challenge detected, waiting up to ${cloudflareMaxWait}s...`);
    for (let i = 0; i < cloudflareMaxWait; i++) {
      await this.sleep(1000);
      if (!(await this.isCloudflareChallenge(page))) {
        this.log(`[${sku}] Challenge passed after ${i + 1}s, current URL: ${page.url()}`);
        return true;
      }
      if (i % 5 === 0) {
        try {
          await page.mouse.move(Math.floor(Math.random() * 600) + 200, Math.floor(Math.random() * 400) + 200);
        } catch (e) {}
      }
    }
    this.log(`[${sku}] Cloudflare challenge still present after ${cloudflareMaxWait}s`);
    return false;
  }

  async extractProductUrlFromDataLayer(page, sku, timeoutMs = 20000) {
    // Fast-path: 一次同步 evaluate，立即判定业务结果。
    // - 无结果（result_number === 0） → 直接返回 ['', '']，不浪费等待时间
    // - 有结果且 sku 在 goods_list_params → 立即返回 [url, title]
    // - 有结果但 sku 不在列表（IP/反爬）→ 进 slow-path 慢等待
    // - dataLayer 从未出现 → 抛 DATA_LAYER_NEVER_PUSHED，让上层换 IP
    try {
      const fast = await page.evaluate((s) => {
        const dl = window.dataLayer;
        if (!dl) return { state: 'no_dataLayer' };
        for (const item of dl) {
          const search = item?.search;
          if (!search) continue;
          if (search.result_number === 0) {
            return { state: 'not_found' };
          }
          if (search.goods_list_params && search.goods_list_params[s]) {
            const hit = search.goods_list_params[s];
            return { state: 'found', url: hit.goodsUrl || '', title: hit.title || '' };
          }
          if (typeof search.result_number === 'number' && search.result_number > 0) {
            return { state: 'dataLayer_missing' };
          }
        }
        return { state: 'no_dataLayer' };
      }, sku);

      if (fast.state === 'no_dataLayer') {
        this.log(`[${sku}] dataLayer fast-path: never pushed`);
        try {
          await captureDiagnostics(page, sku, 'dataLayer-never-pushed', this.config.diagnosticDir);
        } catch (diagErr) {
          this.log(`[${sku}] diagnostic capture failed: ${diagErr.message}`);
        }
        const err = new Error('DATA_LAYER_NEVER_PUSHED');
        throw err;
      }
      if (fast.state === 'not_found') {
        this.log(`[${sku}] dataLayer fast-path: result_number=0`);
        // 业务无结果：用三元组 ['', '', 'not_found'] 告诉 caller 这不是异常
        return ['', '', 'not_found'];
      }
      if (fast.state === 'found') {
        return [fast.url, fast.title];
      }
      // fast.state === 'dataLayer_missing' → 进 slow-path
    } catch (e) {
      if (e.message === 'DATA_LAYER_NEVER_PUSHED') throw e;
      // fast-path 自身出错（evaluate 抛异常） → 保守进 slow-path
    }

    // Slow-path: result_number > 0 但目标 sku 不在列表里。
    // 这种是 IP/反爬场景，等久一点看看是否补齐。
    try {
      await page.waitForFunction((s) => {
        if (typeof window === 'undefined' || !window.dataLayer) return false;
        return window.dataLayer.some(item => item?.search?.goods_list_params?.[s]);
      }, sku, { timeout: timeoutMs });

      const result = await page.evaluate((s) => {
        for (const item of window.dataLayer || []) {
          const glp = item?.search?.goods_list_params;
          if (glp && glp[s]) {
            return [glp[s].goodsUrl || '', glp[s].title || ''];
          }
        }
        return ['', ''];
      }, sku);

      return result;
    } catch (e) {
      this.log(`[${sku}] dataLayer slow-path timeout/error: ${e.message}`);
      try {
        await captureDiagnostics(page, sku, 'dataLayer-missing', this.config.diagnosticDir);
      } catch (diagErr) {
        this.log(`[${sku}] diagnostic capture failed: ${diagErr.message}`);
      }
      const err = new Error('DATA_LAYER_MISSING: ' + e.message);
      throw err;
    }
  }

  async extractFromHtml(page, sku) {
    const html = await page.content();

    const skuEscaped = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nearSkuRegex = new RegExp(`"sku":"${skuEscaped}"[\\s\\S]{0,500}?"goodsUrl":"([^"]*)"`, 'i');
    const nearMatch = html.match(nearSkuRegex);
    if (nearMatch) {
      const url = nearMatch[1].replace(/\\\//g, '/');
      const titleMatch = html.match(new RegExp(`"sku":"${skuEscaped}"[\\s\\S]{0,500}?"title":"([^"]*)"`, 'i'));
      return [url, titleMatch ? titleMatch[1] : ''];
    }

    const goodsUrlMatch = html.match(/"goodsUrl":"([^"]*)"/);
    if (goodsUrlMatch) {
      const url = goodsUrlMatch[1].replace(/\\\//g, '/');
      const titleMatch = html.match(/"title":"([^"]*)"/);
      return [url, titleMatch ? titleMatch[1] : ''];
    }

    const pLinkMatch = html.match(/href="([^"]*\/p\/[^"]*)"/);
    if (pLinkMatch) return [pLinkMatch[1], ''];

    return ['', ''];
  }

  async extractProductUrlWithRetry(page, sku) {
    const maxAttempts = this.dataLayerMaxRetries + 1;
    let lastDataLayerError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let productUrl = '';
      let productName = '';
      let businessNotFound = false;
      let dataLayerThrew = false;
      try {
        const extractResult = await this.extractProductUrlFromDataLayer(page, sku);
        // 业务无结果时 dataLayer 返回三元组 ['', '', 'not_found']
        if (extractResult.length === 3 && extractResult[2] === 'not_found') {
          businessNotFound = true;
        } else {
          [productUrl, productName] = extractResult;
        }
      } catch (e) {
        // DATA_LAYER_NEVER_PUSHED / DATA_LAYER_MISSING：标记后仍尝试 HTML 兜底
        // (channel 也会捕获这个错误做换 IP 决策，但只要 HTML 能拿到结果就算 success)
        if (e.message && /^DATA_LAYER_/.test(e.message)) {
          dataLayerThrew = true;
          lastDataLayerError = e;
          this.log(`[${sku}] dataLayer error: ${e.message}, trying HTML fallback`);
        } else {
          throw e;
        }
      }

      if (productUrl) {
        return { productUrl, productName, dataLayerFailed: false, dataLayerNotFound: false };
      }

      const [htmlUrl, htmlName] = await this.extractFromHtml(page, sku);
      if (htmlUrl) {
        this.log(`[${sku}] Found from HTML regex: ${htmlUrl}`);
        // 业务无结果即使 HTML 拿到，也不应触发换 IP（IP 没问题，纯粹是 SKU 在 EU 没匹配）
        if (businessNotFound) {
          return { productUrl: htmlUrl, productName: htmlName, dataLayerFailed: false, dataLayerNotFound: true };
        }
        return { productUrl: htmlUrl, productName: htmlName, dataLayerFailed: true, dataLayerNotFound: false };
      }

      // 业务无结果 + HTML 也没有 → 通知 caller 这是 not_found，不是 dataLayer 失败
      if (businessNotFound) {
        return { productUrl: '', productName: '', dataLayerFailed: false, dataLayerNotFound: true };
      }

      // 第一次 dataLayer 抛错后 HTML 也没救，且 attempt 走完了 → 重抛原 dataLayer 错误
      // 让 channel 知道这次需要换 IP；否则会被 caller 翻译成 not_found 但 channel 不会触发换 IP
      if (dataLayerThrew && attempt === maxAttempts - 1) {
        throw lastDataLayerError;
      }
    }
    return { productUrl: '', productName: '', dataLayerFailed: true, dataLayerNotFound: false };
  }

  async extractPageSku(page) {
    try {
      const dlSku = await page.evaluate(() => {
        try {
          if (window.dataLayer) {
            for (const item of window.dataLayer) {
              if (item?.product?.sku) return item.product.sku;
              if (item?.ecommerce?.detail?.products?.[0]?.sku) return item.ecommerce.detail.products[0].sku;
            }
          }
          return '';
        } catch (e) {
          return '';
        }
      });
      if (dlSku) return dlSku;

      const html = await page.content();
      // 至少 5 个字符，减少误匹配极短字符串
      const match = html.match(/"sku":"([^"]{5,})"/);
      if (match) return match[1].trim();
      const metaMatch = html.match(/<meta\s+[^>]*?\bname=["']?sku["']?[^>]*?\bcontent=["']([^"']+)["'][^>]*>/i)
        || html.match(/<meta\s+[^>]*?\bcontent=["']([^"']+)["'][^>]*?\bname=["']?sku["']?[^>]*>/i);
      if (metaMatch) return metaMatch[1].trim();
      return '';
    } catch (e) {
      return '';
    }
  }

  async hasNoResult(page) {
    const html = await page.content().catch(() => '');
    const lower = html.toLowerCase();
    return lower.includes('no result') || lower.includes('no products') || lower.includes('0 results') ||
           lower.includes('no items') || lower.includes('we couldn\'t find');
  }

  async extractAllProductImages(page) {
    const rawUrls = await page.evaluate(() => {
      const result = [];
      const allImgs = document.querySelectorAll('img');
      for (const img of allImgs) {
        const src = img.getAttribute('data-src') || img.src || '';
        if (src.includes('img.vevorstatic.com') &&
            (src.includes('goods_img') || src.includes('original_img')) &&
            !src.includes('thumb') &&
            !src.includes('adsimg')) {
          result.push(src);
        }
      }
      return result;
    });

    const bestUrls = {};
    for (const url of rawUrls) {
      const decoded = decodeURIComponent(url);
      const parts = decoded.split('/');
      let filename = parts[parts.length - 1] || '';
      filename = filename.split('?')[0];
      if (!bestUrls[filename]) {
        bestUrls[filename] = url;
      } else if (url.includes('goods_img_big') && bestUrls[filename].includes('original_img')) {
        bestUrls[filename] = url;
      }
    }
    return Object.values(bestUrls);
  }

  async crawlSingleSku(sku, page, recreateContext) {
    const { baseUrl, imageDir, maxImages } = this.config;
    const result = {
      sku,
      product_name: '',
      features_details: '',
      product_specification: '',
      image_paths: '',
      status: '',
      product_url: '',
      error: '',
    };

    try {
      const searchUrl = `${baseUrl}/s/${encodeSkuForSearchPath(sku)}`;
      this.log(`[${sku}] Searching: ${searchUrl}`);
      await gotoWithRetry(page, searchUrl, {
        sku,
        gotoMaxRetries: this.gotoMaxRetries,
        gotoTimeout: this.gotoTimeout,
        gotoRetryDelays: this.gotoRetryDelays,
        recreateContext,
        log: this.log.bind(this),
      });

      if (await this.isCloudflareChallenge(page)) {
        const passed = await this.waitForCloudflare(page, sku);
        if (!passed) {
          try {
            await captureDiagnostics(page, sku, 'cf-challenge', this.config.diagnosticDir);
          } catch (diagErr) {
            this.log(`[${sku}] CF diagnostic capture failed: ${diagErr.message}`);
          }
          result.status = 'not_found';
          result.error = 'CF_CHALLENGE_UNRESOLVED';
          result.dataLayerFailed = true;
          result.cfChallengeFailed = true;
          this.log(`[${sku}] Cloudflare challenge not resolved after ${this.config.cloudflareMaxWait}s, marking not_found + rotation trigger`);
          return result;
        }
      }

      await this.sleep(2000);

      const currentUrl = page.url();
      this.log(`[${sku}] Current URL: ${currentUrl}`);

      const extractResult = await this.extractProductUrlWithRetry(page, sku);
      let productUrl = extractResult.productUrl;
      let productName = extractResult.productName;
      result.dataLayerFailed = extractResult.dataLayerFailed;
      result.dataLayerNotFound = !!extractResult.dataLayerNotFound;
      if (productUrl) this.log(`[${sku}] Final product URL: ${productUrl}`);

      if (productUrl) {
        result.product_name = productName;
        this.log(`[${sku}] Final product URL: ${productUrl}`);
      }

      if (!productUrl && currentUrl.includes('/p/') && !currentUrl.endsWith('/s/' + sku)) {
        productUrl = currentUrl;
        this.log(`[${sku}] Direct to product page`);
      }

      if (!productUrl) {
        const noResult = await this.hasNoResult(page);
        result.status = 'not_found';
        result.error = noResult ? 'Page shows no result' : 'No product URL found';
        this.log(`[${sku}] Product not found (${noResult ? 'page confirms no result' : 'no URL extracted'})`);
        return result;
      }

      result.product_url = productUrl;
      await gotoWithRetry(page, productUrl, {
        sku,
        gotoMaxRetries: this.gotoMaxRetries,
        gotoTimeout: this.gotoTimeout,
        gotoRetryDelays: this.gotoRetryDelays,
        recreateContext,
        log: this.log.bind(this),
      });

      if (await this.isCloudflareChallenge(page)) {
        const passed = await this.waitForCloudflare(page, sku);
        if (!passed) {
          try {
            await captureDiagnostics(page, sku, 'cf-challenge-product', this.config.diagnosticDir);
          } catch (diagErr) {
            this.log(`[${sku}] CF diagnostic capture (product) failed: ${diagErr.message}`);
          }
          result.status = 'not_found';
          result.error = 'CF_CHALLENGE_UNRESOLVED';
          result.dataLayerFailed = true;
          result.cfChallengeFailed = true;
          this.log(`[${sku}] Cloudflare challenge on product page not resolved after ${this.config.cloudflareMaxWait}s, marking not_found + rotation trigger`);
          return result;
        }
      }

      await this.sleep(2000);

      const pageSku = await this.extractPageSku(page);
      if (pageSku && pageSku.toUpperCase() !== sku.toUpperCase()) {
        result.status = 'sku_mismatch';
        result.error = `SKU mismatch: searched ${sku}, page SKU is ${pageSku}`;
        result.product_url = page.url();
        this.log(`[${sku}] ${result.error}`);
        return result;
      }

      await this.sleep(6000);

      if (!result.product_name) {
        const titleEl = await page.$('h1');
        if (titleEl) {
          result.product_name = (await titleEl.innerText()).trim();
        }
      }

      result.features_details = await page.evaluate(() => {
        const container = document.querySelector('.DM_features_details');
        if (!container) return '';
        const items = container.querySelectorAll('p, li');
        const out = [];
        for (const item of items) {
          const text = item.innerText.trim();
          if (text && text.length > 5) out.push(text);
        }
        return out.join('\\n');
      });

      result.product_specification = await page.evaluate(() => {
        let aboutContainer = document.querySelector('.DM_aboutThisItem');
        if (aboutContainer) {
          const dls = aboutContainer.querySelectorAll('.DM_at-goodsDescAttr dl.goodsDesc_item');
          if (dls.length > 0) {
            const out = [];
            for (const dl of dls) {
              const dt = dl.querySelector('dt');
              const dd = dl.querySelector('dd');
              if (dt && dd) {
                const label = dt.innerText.trim();
                const value = dd.innerText.trim();
                if (label && value) out.push(`${label}: ${value}`);
              }
            }
            if (out.length > 0) return out.join('\\n');
          }
        }

        const container = document.querySelector('.DM_product_specification');
        if (!container) return '';
        const items = container.querySelectorAll('li');
        const out = [];
        for (const item of items) {
          const labelEl = item.querySelector('.DM_PS-label');
          const valueEl = item.querySelector('.DM_PS-value');
          if (labelEl && valueEl) {
            const label = labelEl.innerText.trim();
            const value = valueEl.innerText.trim();
            if (label && value) out.push(`${label}: ${value}`);
          } else {
            const text = item.innerText.trim();
            if (text && text.length > 3) {
              const cleanText = text.replace(/\\n+/g, ': ').replace(/\\s+/g, ' ').trim();
              if (cleanText.includes(':')) out.push(cleanText);
            }
          }
        }
        return out.join('\\n');
      });

      const mainImgs = await this.extractAllProductImages(page);
      this.log(`[${sku}] Found ${mainImgs.length} unique product images`);

      const downloadedPaths = [];
      for (let i = 0; i < Math.min(mainImgs.length, maxImages); i++) {
        try {
          const imgUrl = mainImgs[i].replace(/\?.*$/, '');
          let ext = '.jpg';
          if (imgUrl.toLowerCase().includes('.png')) ext = '.png';
          else if (imgUrl.toLowerCase().includes('.webp')) ext = '.webp';
          const imgFilename = `${sku}_${i + 1}${ext}`;
          const imgPath = path.join(imageDir, imgFilename);
          const buffer = await this.downloadImage(imgUrl);
          fs.writeFileSync(imgPath, buffer);
          downloadedPaths.push(imgPath);
          this.log(`[${sku}] Downloaded image ${i + 1}: ${imgFilename}`);
        } catch (e) {
          this.log(`[${sku}] Image ${i + 1} download error: ${e.message}`);
        }
      }

      result.image_paths = downloadedPaths.join(';');
      result.status = 'success';
      this.log(`[${sku}] Crawl success! Images: ${downloadedPaths.length}`);

    } catch (e) {
      result.status = 'error';
      result.error = e.message;
      this.log(`[${sku}] Error: ${e.message}`);
    }

    return result;
  }
}

function classifyGotoError(error) {
  const msg = (error && error.message) || '';
  if (
    msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
    msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
    msg.includes('ERR_CONNECTION_RESET')
  ) {
    return 'proxy';
  }
  if (
    msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
    /(?:status\s+code\s+|\s)([45]\d{2})(?:\s|$|:)/i.test(msg) ||
    msg.includes('status code')
  ) {
    return 'non-retryable';
  }
  if (
    msg.includes('Timeout') ||
    msg.includes('timeout') ||
    msg.includes('ERR_NAME_NOT_RESOLVED') ||
    (
      msg.includes('net::ERR') &&
      !msg.includes('ERR_TUNNEL_CONNECTION_FAILED') &&
      !msg.includes('ERR_PROXY_CONNECTION_FAILED') &&
      !msg.includes('ERR_CONNECTION_RESET')
    ) ||
    msg.includes('Navigation failed')
  ) {
    return 'retryable';
  }
  return 'non-retryable';
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoWithRetry(page, url, options) {
  const {
    sku,
    gotoMaxRetries = 3,
    gotoTimeout = 30000,
    gotoRetryDelays = [3000, 6000, 12000],
    recreateContext,
    log = console.log,
  } = options || {};

  if (gotoMaxRetries <= 0) {
    throw new Error(`gotoMaxRetries must be > 0, got ${gotoMaxRetries}`);
  }

  let currentPage = page;
  let lastError;
  for (let attempt = 0; attempt < gotoMaxRetries; attempt++) {
    try {
      return await currentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
    } catch (e) {
      lastError = e;
      const category = classifyGotoError(e);
      if (category === 'proxy' || category === 'non-retryable') {
        throw e;
      }
      log(`[${sku}] goto attempt ${attempt + 1}/${gotoMaxRetries} failed for ${url}: ${e.message}`);
      if (attempt < gotoMaxRetries - 1) {
        const delay = gotoRetryDelays[attempt] ?? 5000;
        log(`[${sku}] Retrying goto in ${delay / 1000}s...`);
        await sleep(delay);
        if (attempt === gotoMaxRetries - 2 && typeof recreateContext === 'function') {
          log(`[${sku}] Recreating context for final goto attempt...`);
          currentPage = await recreateContext();
        }
      }
    }
  }
  throw lastError;
}

async function captureDiagnostics(page, sku, label, outputDir) {
  if (!outputDir) {
    return null;
  }

  const now = new Date();
  const dateDir = now.toISOString().slice(0, 10);
  const dir = path.join(outputDir, dateDir);
  fs.mkdirSync(dir, { recursive: true });

  const ts = now.toISOString().replace(/[:.]/g, '-');
  const baseName = `${ts}-${label}-${sku}`;
  const meta = {
    sku,
    label,
    timestamp: now.toISOString(),
    title: '',
    url: '',
    screenshot: null,
    htmlSnippet: null,
    ipInfo: null,
  };

  try {
    meta.title = await page.title().catch(() => '');
  } catch (e) {
    meta.titleError = e.message;
  }

  try {
    meta.url = page.url();
  } catch (e) {
    meta.urlError = e.message;
  }

  try {
    const screenshotPath = path.join(dir, `${baseName}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    meta.screenshot = screenshotPath;
  } catch (e) {
    meta.screenshotError = e.message;
  }

  try {
    const html = await page.content();
    const snippetPath = path.join(dir, `${baseName}.html`);
    fs.writeFileSync(snippetPath, html.slice(0, 8000));
    meta.htmlSnippet = snippetPath;
  } catch (e) {
    meta.htmlError = e.message;
  }

  try {
    const ipInfo = await page.evaluate(() => {
      try {
        return fetch('https://ipinfo.io/json')
          .then(r => r.json())
          .catch(err => ({ error: err.message }));
      } catch (err) {
        return { error: err.message };
      }
    });
    meta.ipInfo = ipInfo;
  } catch (e) {
    meta.ipInfo = { error: e.message };
  }

  try {
    const metaPath = path.join(dir, `${baseName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (e) {
    // Best-effort diagnostics; do not let metadata write failures propagate.
  }

  return meta;
}

module.exports = { PageCrawler, classifyGotoError, gotoWithRetry, encodeSkuForSearchPath, captureDiagnostics };
