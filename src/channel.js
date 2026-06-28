const { chromium } = require('playwright');
const { PageCrawler, classifyGotoError } = require('./page-crawler');

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
    this.consecutiveFailures = 0;
    this.lastFailureWasProxy = false;
    this.pageCrawler = new PageCrawler({
      baseUrl: this.config.baseUrl,
      imageDir: this.config.imageDir,
      userAgent: this.config.userAgent || DEFAULT_USER_AGENT,
      maxImages: this.config.maxImages,
      cloudflareMaxWait: this.config.cloudflareMaxWait,
      minDelay: this.config.minDelay,
      maxDelay: this.config.maxDelay,
      gotoMaxRetries: this.config.gotoMaxRetries,
      gotoTimeout: this.config.gotoTimeout,
      gotoRetryDelays: this.config.gotoRetryDelays,
      dataLayerMaxRetries: this.config.dataLayerMaxRetries,
    });
    this.tasksSincePageRefresh = 0;
    this.pageRefreshAfterTasks = this.config.pageRefreshAfterTasks !== undefined ? this.config.pageRefreshAfterTasks : 20;
    this.headedBrowserLauncher = options.headedBrowserLauncher || null;
    this.headedFallback = options.config && options.config.headedFallback !== false;
    this.dataLayerFailureCount = 0;
    this.dataLayerFailureThreshold = this.config.dataLayerFailureThreshold !== undefined ? this.config.dataLayerFailureThreshold : 3;
  }

  _buildContextOptions() {
    const userAgent = this.config.userAgent || DEFAULT_USER_AGENT;
    const viewport = this.config.viewport || DEFAULT_VIEWPORT;
    const locale = this.config.locale || 'en-GB';
    const timezone = this.config.timezone || 'Europe/London';
    const contextOptions = { userAgent, viewport, locale, timezoneId: timezone };
    if (this.config.proxy) {
      contextOptions.proxy = { server: this.config.proxy };
    }
    return contextOptions;
  }

  async recreateContext(browser) {
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (e) {
        // Ignore errors when context is already closed or browser is dead
      }
    }

    const contextOptions = this._buildContextOptions();

    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    return this.page;
  }

  async refreshPage() {
    if (this.page) {
      try {
        await this.page.close();
      } catch (e) {
        // Ignore errors when page is already closed
      }
    }
    if (this.browserContext) {
      this.page = await this.browserContext.newPage();
    }
    this.tasksSincePageRefresh = 0;
  }

  async refreshPageIfNeeded() {
    if (this.pageRefreshAfterTasks > 0 && this.tasksSincePageRefresh >= this.pageRefreshAfterTasks) {
      await this.refreshPage();
    }
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

  async init(browser, proxyOverride) {
    if (proxyOverride !== undefined) {
      this.config.proxy = proxyOverride;
    }
    const contextOptions = this._buildContextOptions();

    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    this.log(`[Channel ${this.id}] initialized`);
  }

  async runHeadedFallback(task) {
    if (!this.headedBrowserLauncher) {
      throw new Error('headedBrowserLauncher not configured');
    }
    const headedBrowser = await this.headedBrowserLauncher();
    let headedContext;
    let headedPage;
    try {
      headedContext = await headedBrowser.newContext(this._buildContextOptions());
      await headedContext.addInitScript(this.getStealthScript());
      headedPage = await headedContext.newPage();
      const recreateContext = async () => {
        if (headedContext) {
          try {
            await headedContext.close();
          } catch (e) {
            // ignore
          }
        }
        headedContext = await headedBrowser.newContext(this._buildContextOptions());
        await headedContext.addInitScript(this.getStealthScript());
        headedPage = await headedContext.newPage();
        return headedPage;
      };
      return await this.pageCrawler.crawlSingleSku(task.sku, headedPage, recreateContext);
    } finally {
      if (headedContext) {
        try {
          await headedContext.close();
        } catch (e) {
          // ignore
        }
      }
      await headedBrowser.close();
    }
  }

  async crawl(task) {
    if (this.busy) {
      throw new Error(`Channel ${this.id} is busy`);
    }
    this.busy = true;
    this.currentTask = task;

    try {
      this.log(`[Channel ${this.id}] start task ${task.crawlerTaskId} sku ${task.sku}`);
      let result;
      try {
        const recreateContext = async () => {
          const browser = this.browserContext ? this.browserContext.browser() : null;
          if (!browser) throw new Error('Browser context not available');
          return this.recreateContext(browser);
        };
        result = await this.pageCrawler.crawlSingleSku(task.sku, this.page, recreateContext);
        if (result.dataLayerFailed) {
          this.dataLayerFailureCount++;
          if (this.dataLayerFailureCount >= this.dataLayerFailureThreshold) {
            this.log(`[Channel ${this.id}] WARNING: dataLayer extraction failed for ${this.dataLayerFailureCount} consecutive tasks (threshold: ${this.dataLayerFailureThreshold}); possible network/IP/rendering issue`);
          }
        } else {
          this.dataLayerFailureCount = 0;
        }
      } catch (e) {
        const isTimeout = e.name === 'TimeoutError' || (e.message && /Timeout \d+ms exceeded/.test(e.message));
        const isRetryableNetwork = classifyGotoError(e) === 'retryable' || (e.message && e.message.includes('net::ERR'));
        if ((isTimeout || isRetryableNetwork) && this.headedFallback && this.headedBrowserLauncher) {
          this.log(`[Channel ${this.id}] Headless request failed, trying headed fallback for task ${task.crawlerTaskId}`);
          result = await this.runHeadedFallback(task);
        } else {
          throw e;
        }
      }
      result.crawlerTaskId = task.crawlerTaskId;
      const summary = {
        status: result.status,
        product_name: result.product_name,
        product_url: result.product_url,
        error: result.error,
        image_count: result.images ? result.images.length : 0,
      };
      this.log(`[Channel ${this.id}] done task ${task.crawlerTaskId} status ${result.status} result=${JSON.stringify(summary)}`);
      this.consecutiveFailures = 0;
      this.lastFailureWasProxy = false;
      return result;
    } catch (e) {
      this.consecutiveFailures++;
      this.lastFailureWasProxy = this.isProxyError(e);
      this.log(`[Channel ${this.id}] done task ${task.crawlerTaskId} status error message=${e.message}`);
      const isTimeout = e.name === 'TimeoutError' || (e.message && /Timeout \d+ms exceeded/.test(e.message));
      if (isTimeout) {
        e.status = 'timeout';
      }
      throw e;
    } finally {
      this.busy = false;
      this.currentTask = null;
      this.tasksSincePageRefresh++;
      try {
        await this.refreshPageIfNeeded();
      } catch (refreshErr) {
        this.log(`[Channel ${this.id}] page refresh failed: ${refreshErr.message}`);
      }
    }
  }

  async isHealthy() {
    if (this.busy) {
      return true;
    }
    if (!this.page || !this.browserContext) {
      return false;
    }
    try {
      let browser;
      try {
        browser = this.browserContext.browser();
      } catch (e) {
        return false;
      }
      if (!browser.isConnected() || this.page.isClosed()) {
        return false;
      }
      // Verify the page context is actually usable by executing a trivial script
      await this.page.evaluate(() => document.title);
      return true;
    } catch (e) {
      return false;
    }
  }

  isProxyError(e) {
    const msg = (e && e.message) || '';
    return msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
           msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
           msg.includes('ERR_CONNECTION_RESET');
  }

  async reinit(browser, proxyOverride) {
    await this.close();
    await this.init(browser, proxyOverride);
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
