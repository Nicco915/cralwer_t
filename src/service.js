const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Poller } = require('./poller');
const { Worker } = require('./worker');
const { Channel } = require('./channel');
const { Pusher } = require('./pusher');
const { resolveBrowserPath } = require('./crawler');

class CrawlerService {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.channels = [];
    this.poller = null;
    this.worker = null;
    this.pusher = null;
    this.shuttingDown = false;
    this.shutdownResolve = null;
    this.shutdownPromise = null;
  }

  log(...args) {
    console.log(...args);
  }

  ensureImageDir() {
    const { imageDir } = this.config;
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
    }
  }

  async initBrowser() {
    const { headless, browserPath, userAgent, viewport, locale, timezone } = this.config;
    const resolvedBrowser = resolveBrowserPath(browserPath);
    if (resolvedBrowser) {
      this.log(`[BROWSER] Using: ${resolvedBrowser}`);
    } else {
      this.log('[BROWSER] Edge not found, falling back to Playwright bundled Chromium');
    }

    this.browser = await chromium.launch({
      headless,
      executablePath: resolvedBrowser,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--lang=en-GB',
      ],
    });
  }

  async initChannels() {
    const { channels: channelCount } = this.config;
    for (let i = 1; i <= channelCount; i++) {
      const channel = new Channel({
        id: i,
        config: {
          baseUrl: this.config.baseUrl,
          imageDir: this.config.imageDir,
          userAgent: this.config.userAgent,
          viewport: this.config.viewport,
          locale: this.config.locale,
          timezone: this.config.timezone,
          maxImages: this.config.maxImages,
          cloudflareMaxWait: this.config.cloudflareMaxWait,
          minDelay: this.config.minDelay,
          maxDelay: this.config.maxDelay,
          proxy: this.config.proxy,
        },
        log: this.log.bind(this),
      });
      await channel.init(this.browser);
      this.channels.push(channel);
      this.worker.addChannel(channel);
    }
  }

  async start() {
    this.log('[SERVICE] Starting crawler service...');
    this.ensureImageDir();

    this.shutdownPromise = new Promise((resolve) => {
      this.shutdownResolve = resolve;
    });

    this.pusher = new Pusher({
      callbackUrl: this.config.callbackUrl,
      nodeCode: this.config.nodeCode,
      nodeToken: this.config.nodeToken,
      maxRetries: this.config.pushRetries,
      retryDelays: [1000, 2000, 4000],
    });

    this.worker = new Worker({
      pusher: this.pusher,
      log: this.log.bind(this),
    });

    this.poller = new Poller({
      taskUrl: this.config.taskUrl,
      nodeCode: this.config.nodeCode,
      nodeToken: this.config.nodeToken,
      limit: this.config.pollLimit,
      pollInterval: this.config.pollInterval,
    });

    await this.initBrowser();
    await this.initChannels();

    this.worker.start();
    this.poller.start((tasks) => {
      this.worker.pushTasks(tasks);
    });

    this.log(`[SERVICE] Running with nodeCode=${this.config.nodeCode}, channels=${this.config.channels}`);

    this.startHealthCheck();
    this.registerSignalHandlers();
  }

  async stop() {
    if (this.shuttingDown) return this.shutdownPromise;
    this.shuttingDown = true;
    this.log('[SERVICE] Shutting down gracefully...');

    this.stopHealthCheck();
    this.poller.stop();
    await this.worker.drain();

    for (const channel of this.channels) {
      await channel.close();
    }
    if (this.browser) {
      await this.browser.close();
    }

    this.log('[SERVICE] Shutdown complete');
    if (this.shutdownResolve) {
      this.shutdownResolve();
    }
  }

  startHealthCheck() {
    const interval = this.config.browserHealthCheckInterval || 30000;
    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        this.log('[SERVICE] Health check error:', err.message);
      });
    }, interval);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  async runHealthCheck() {
    if (this.restartingBrowser) {
      return;
    }

    const browserHealthy = this.browser && this.browser.isConnected();
    if (!browserHealthy) {
      this.log('[SERVICE] Browser disconnected detected');
      await this.restartBrowser();
      return;
    }

    for (const channel of this.channels) {
      const healthy = await channel.isHealthy();
      if (!healthy) {
        this.log(`[SERVICE] Channel ${channel.id} unhealthy detected`);
        await this.restartBrowser();
        return;
      }
    }
  }

  async restartBrowser() {
    if (this.restartingBrowser) {
      return;
    }
    this.restartingBrowser = true;
    this.log('[SERVICE] Browser unhealthy, restarting...');

    try {
      this.worker.stop();

      for (const channel of this.channels) {
        await channel.close();
      }
      this.channels = [];
      this.worker.resetChannels();

      if (this.browser && this.browser.isConnected()) {
        await this.browser.close();
      }
      this.browser = null;

      await this.initBrowser();
      await this.initChannels();

      this.worker.start();
      this.log('[SERVICE] Browser restarted');
    } catch (err) {
      this.log('[SERVICE] Browser restart failed:', err.message);
    } finally {
      this.restartingBrowser = false;
    }
  }

  registerSignalHandlers() {
    const shutdown = async (signal) => {
      this.log(`\n[SERVICE] ${signal} received`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

async function runService(config) {
  const service = new CrawlerService(config);
  await service.start();
  return service;
}

module.exports = { CrawlerService, runService };
