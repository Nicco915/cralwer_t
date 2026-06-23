const { chromium } = require('playwright');
const { PageCrawler } = require('./page-crawler');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

class Channel {
  constructor(options) {
    this.id = options.id;
    this.config = options.config || {};
    this.log = options.log || console.log;
    this.browserContext = null;
    this.page = null;
    this.busy = false;
    this.currentTask = null;
    this.pageCrawler = new PageCrawler({
      baseUrl: this.config.baseUrl,
      imageDir: this.config.imageDir,
      userAgent: this.config.userAgent || DEFAULT_USER_AGENT,
      maxImages: this.config.maxImages,
      cloudflareMaxWait: this.config.cloudflareMaxWait,
      minDelay: this.config.minDelay,
      maxDelay: this.config.maxDelay,
    });
  }

  getStealthScript() {
    return `() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      window.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters);
    }`;
  }

  async init(browser) {
    const userAgent = this.config.userAgent || DEFAULT_USER_AGENT;
    const viewport = this.config.viewport || DEFAULT_VIEWPORT;
    const locale = this.config.locale || 'en-GB';
    const timezone = this.config.timezone || 'Europe/London';

    const contextOptions = {
      userAgent,
      viewport,
      locale,
      timezoneId: timezone,
    };

    if (this.config.proxy) {
      contextOptions.proxy = { server: this.config.proxy };
    }

    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    this.log(`[Channel ${this.id}] initialized`);
  }

  async crawl(task) {
    if (this.busy) {
      throw new Error(`Channel ${this.id} is busy`);
    }
    this.busy = true;
    this.currentTask = task;

    try {
      this.log(`[Channel ${this.id}] start task ${task.crawlerTaskId} sku ${task.sku}`);
      const result = await this.pageCrawler.crawlSingleSku(task.sku, this.page);
      result.crawlerTaskId = task.crawlerTaskId;
      this.log(`[Channel ${this.id}] done task ${task.crawlerTaskId} status ${result.status}`);
      return result;
    } finally {
      this.busy = false;
      this.currentTask = null;
    }
  }

  async isHealthy() {
    if (!this.page || !this.browserContext) {
      return false;
    }
    try {
      return this.browserContext.browser().isConnected() && !this.page.isClosed();
    } catch (e) {
      return false;
    }
  }

  async reinit(browser) {
    await this.close();
    await this.init(browser);
  }

  async close() {
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (e) {
        // Ignore errors when context is already closed or browser is dead
      }
      this.browserContext = null;
      this.page = null;
    }
  }
}

module.exports = { Channel };
