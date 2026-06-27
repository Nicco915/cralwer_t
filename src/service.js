const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Poller } = require('./poller');
const { Worker } = require('./worker');
const { Channel } = require('./channel');
const { Pusher } = require('./pusher');
const { resolveBrowserPath } = require('./crawler');
const { KuaidailiClient } = require('./kuaidaili-client');
const { ProxyPool } = require('./proxy-pool');
const { CliproxyPool } = require('./cliproxy-pool');

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
    this.healthCheckTimer = null;
    this.restartPromise = null;
    this.proxyPool = null;
    this.proxyRefreshTimer = null;
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

  async initBrowser(options = {}) {
    const headless = options.headless !== undefined ? options.headless : this.config.headless;
    const { browserPath, browserTempDir, userAgent, viewport, locale, timezone } = this.config;
    const resolvedBrowser = resolveBrowserPath(browserPath);
    if (resolvedBrowser) {
      this.log(`[BROWSER] Using: ${resolvedBrowser}`);
    } else {
      this.log('[BROWSER] Edge not found, falling back to Playwright bundled Chromium');
    }

    const tempDir = browserTempDir || path.resolve('./output/browser-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    this.browser = await chromium.launch({
      headless,
      executablePath: resolvedBrowser,
      tracesDir: tempDir,
      downloadsPath: tempDir,
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
    return this.browser;
  }

  async initChannels() {
    const { channels: channelCount } = this.config;
    for (let i = 1; i <= channelCount; i++) {
      const channelId = `ch-${i}`;
      const proxy = this.proxyPool
        ? this.proxyPool.getProxyForChannel(channelId)
        : this.config.proxy;
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
          proxy,
          gotoMaxRetries: this.config.gotoMaxRetries,
          gotoTimeout: this.config.gotoTimeout,
          gotoRetryDelays: this.config.gotoRetryDelays,
          headedFallback: this.config.headedFallback,
          pageRefreshAfterTasks: this.config.pageRefreshAfterTasks,
        },
        headedBrowserLauncher: () => this.initBrowser({ headless: false }),
        log: this.log.bind(this),
      });
      await channel.init(this.browser);
      this.channels.push(channel);
      this.worker.addChannel(channel);
    }
  }

  async startProxyPool() {
    if (this.config.proxy) {
      return;
    }

    const hasKuaidaili = this.config.kuaidailiSecretId && this.config.kuaidailiSecretKey;
    const hasCliproxy = this.config.cliproxyUsername && this.config.cliproxyPassword;

    if (hasKuaidaili && hasCliproxy) {
      throw new Error('Kuaidaili and Cliproxy credentials are mutually exclusive; configure only one proxy pool');
    }

    if (hasKuaidaili) {
      const client = new KuaidailiClient({
        secretId: this.config.kuaidailiSecretId,
        secretKey: this.config.kuaidailiSecretKey,
        proxyType: this.config.kuaidailiProxyType,
        proxyNum: this.config.kuaidailiProxyNum,
        tokenCacheFile: this.config.kuaidailiTokenCacheFile,
      });
      this.proxyPool = new ProxyPool({
        client,
        machineIndex: this.config.proxyMachineIndex,
        machineTotal: this.config.proxyMachineTotal,
        channels: this.config.channels,
        assignmentsFile: this.config.proxyAssignmentsFile,
      });
      await this.proxyPool.assign();
      this.startProxyRefresh();
      return;
    }

    if (hasCliproxy) {
      this.proxyPool = new CliproxyPool({
        host: this.config.cliproxyHost,
        port: this.config.cliproxyPort,
        username: this.config.cliproxyUsername,
        password: this.config.cliproxyPassword,
        region: this.config.cliproxyRegion,
        stickyMinutes: this.config.cliproxyStickyMinutes,
        sessionPrefix: this.config.cliproxySessionPrefix,
        channels: this.config.channels,
        assignmentsFile: this.config.cliproxyAssignmentsFile,
      });
      await this.proxyPool.assign();
      this.startProxyRefresh();
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
      shouldPoll: () => this.worker.hasCapacity(),
    });

    await this.startProxyPool();

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
    this.stopProxyRefresh();
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

  startProxyRefresh() {
    const interval = this.config.proxyRefreshIntervalMs || 300000;
    this.proxyRefreshTimer = setInterval(async () => {
      try {
        const changed = await this.proxyPool.refresh();
        if (changed.length > 0) {
          this.log('[PROXY] Refresh changed proxies:', changed);
          for (const channel of this.channels) {
            const channelId = `ch-${channel.id}`;
            if (changed.includes(channelId)) {
              const newProxy = this.proxyPool.getProxyForChannel(channelId);
              this.log(`[PROXY] Reinitializing channel ${channel.id} with ${newProxy}`);
              await channel.reinit(this.browser, newProxy);
            }
          }
        }
      } catch (e) {
        this.log('[PROXY] Refresh failed:', e.message);
      }
    }, interval);
  }

  stopProxyRefresh() {
    if (this.proxyRefreshTimer) {
      clearInterval(this.proxyRefreshTimer);
      this.proxyRefreshTimer = null;
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
    const browserHealthy = this.browser && this.browser.isConnected();
    if (!browserHealthy) {
      this.log('[SERVICE] Browser disconnected detected');
      await this.restartBrowser();
      return;
    }

    for (const channel of this.channels) {
      const healthy = await channel.isHealthy();
      const proxyFailed = channel.consecutiveFailures >= 2 && channel.lastFailureWasProxy;
      if (!healthy || proxyFailed) {
        if (proxyFailed) {
          this.log(`[SERVICE] Channel ${channel.id} has ${channel.consecutiveFailures} consecutive proxy failures, rotating proxy`);
        } else {
          this.log(`[SERVICE] Channel ${channel.id} unhealthy detected`);
        }
        if (this.proxyPool) {
          try {
            const channelId = `ch-${channel.id}`;
            const newProxy = await this.proxyPool.nextForChannel(channelId);
            this.log(`[SERVICE] Rotating channel ${channel.id} to ${newProxy}`);
            channel.consecutiveFailures = 0;
            channel.lastFailureWasProxy = false;
            await channel.reinit(this.browser, newProxy);
            const stillUnhealthy = !(await channel.isHealthy());
            if (!stillUnhealthy) {
              this.log(`[SERVICE] Channel ${channel.id} recovered after proxy rotation`);
              continue;
            }
          } catch (e) {
            this.log(`[SERVICE] Proxy rotation failed for channel ${channel.id}:`, e.message);
          }
        }
        await this.restartBrowser();
        return;
      }
    }
  }

  async restartBrowser() {
    if (this.restartPromise) {
      return this.restartPromise;
    }

    this.restartPromise = (async () => {
      this.log('[SERVICE] Browser unhealthy, restarting...');

      try {
        this.worker.stop();
        await this.worker.drain();

        for (const channel of this.channels) {
          await channel.close();
        }
        this.channels = [];
        this.worker.resetChannels();

        if (this.browser && this.browser.isConnected()) {
          await this.browser.close();
        }
        this.browser = null;

        if (this.proxyPool) {
          try { await this.proxyPool.refresh(); } catch (e) { this.log('[PROXY] refresh on restart failed:', e.message); }
        }

        await this.initBrowser();
        await this.initChannels();

        this.worker.start();
        this.log('[SERVICE] Browser restarted');
      } catch (err) {
        this.log('[SERVICE] Browser restart failed:', err.message);
        throw err;
      }
    })();

    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
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
