const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_CONFIG = {
  baseUrl: 'https://eur.vevor.com',
  imageDir: './output/images',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  maxImages: 5,
  cloudflareMaxWait: 45,
  minDelay: 5,
  maxDelay: 10,
};

function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

class PageCrawler {
  constructor(config) {
    this.config = resolveConfig(config);
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
    const { userAgent } = this.config;
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { headers: { 'User-Agent': userAgent } }, (res) => {
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
      this.log(`[${sku}] dataLayer wait timeout/error: ${e.message}`);
      return ['', ''];
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

  async crawlSingleSku(sku, page) {
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
      const searchUrl = `${baseUrl}/s/${sku}`;
      this.log(`[${sku}] Searching: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      if (await this.isCloudflareChallenge(page)) {
        const passed = await this.waitForCloudflare(page, sku);
        if (!passed) {
          result.status = 'error';
          result.error = 'Cloudflare challenge not resolved automatically';
          return result;
        }
      }

      await this.sleep(2000);

      const currentUrl = page.url();
      this.log(`[${sku}] Current URL: ${currentUrl}`);

      let [productUrl, productName] = await this.extractProductUrlFromDataLayer(page, sku);
      if (!productUrl) {
        [productUrl, productName] = await this.extractFromHtml(page, sku);
        if (productUrl) this.log(`[${sku}] Found from HTML regex: ${productUrl}`);
      }

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
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      if (await this.isCloudflareChallenge(page)) {
        const passed = await this.waitForCloudflare(page, sku);
        if (!passed) {
          result.status = 'error';
          result.error = 'Cloudflare challenge on product page not resolved';
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

module.exports = { PageCrawler, resolveConfig };
