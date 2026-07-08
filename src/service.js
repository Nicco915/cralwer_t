const fs = require('fs');
const path = require('path');
const http = require('node:http');
const { chromium } = require('playwright');
const { Poller } = require('./poller');
const { Worker } = require('./worker');
const { Channel } = require('./channel');
const { Pusher } = require('./pusher');
const { resolveBrowserPath } = require('./crawler');
const { KuaidailiClient } = require('./kuaidaili-client');
const { ProxyPool } = require('./proxy-pool');
const { CliproxyPool } = require('./cliproxy-pool');
const { ImageUploader } = require('./image-uploader');
const { createStdoutLogger, createFileLogger, createBroadcastLogger } = require('./logger');

function maskProxyUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.password = '***';
    parsed.username = '***';
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

class CrawlerService {
  constructor(config) {
    this.config = {
      ...config,
      nodeCode: config?.nodeCode ?? process.env.CRAWLER_NODE_CODE ?? 'crawler-01',
      stealthMode: config?.stealthMode ?? process.env.CRAWLER_STEALTH_MODE ?? 'channel',
    };
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
    this.healthServer = null;
    this.healthServerStartTime = null;
    this.heartbeatTimer = null;
    this.logger = createBroadcastLogger([
      createStdoutLogger({ nodeCode: this.config.nodeCode }),
      createFileLogger({
        nodeCode: this.config.nodeCode,
        logDir: this.config.customLogDir || path.resolve('./logs'),
      }),
    ]);
  }

  log(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    this.logger.info('service', msg, {});
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

    const launchOptions = {
      headless,
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
    };

    if (resolvedBrowser) {
      launchOptions.executablePath = resolvedBrowser;
    } else {
      // Playwright 1.60+ 默认使用 chromium-headless-shell，但该二进制在某些安装环境下会缺失。
      // 指定 channel: 'chromium' 使用完整 Chromium 的 new headless 模式，部署更稳定。
      launchOptions.channel = 'chromium';
    }

    this.browser = await chromium.launch(launchOptions);
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
          diagnosticDir: this.config.diagnosticDir ? path.join(this.config.diagnosticDir, this.config.nodeCode) : undefined,
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
          dataLayerMaxRetries: this.config.dataLayerMaxRetries,
          dataLayerFailureThreshold: this.config.dataLayerFailureThreshold,
          nodeCode: this.config.nodeCode,
          stealthMode: this.config.stealthMode,
          adaptiveTimeoutThreshold: this.config.adaptiveTimeoutThreshold,
          adaptiveRecoverySuccesses: this.config.adaptiveRecoverySuccesses,
          adaptiveDataLayerThreshold: this.config.adaptiveDataLayerThreshold,
          dataLayerProxyRotationThreshold: this.config.dataLayerProxyRotationThreshold,
          cliproxyRotationCooldownMs: this.config.cliproxyRotationCooldownMs,
        },
        headedBrowserLauncher: () => this.initBrowser({ headless: false }),
        onTaskComplete: () => this.checkChannelForRotation(channel),
        log: this.log.bind(this),
      });
      await channel.init(this.browser);
      this.log(`[Node ${this.config.nodeCode}] Channel ${i} profile=${channel.profile.signature} uaHash=${channel.profile.uaHash}`);
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
        asn: this.config.cliproxyAsn,
        stickyMinutes: this.config.cliproxyStickyMinutes,
        sessionPrefix: this.config.cliproxySessionPrefix,
        channels: this.config.channels,
        assignmentsFile: this.config.cliproxyAssignmentsFile,
        regionParamName: this.config.cliproxyRegionParamName,
        asnParamName: this.config.cliproxyAsnParamName,
        sessionParamName: this.config.cliproxySessionParamName,
        stickyParamName: this.config.cliproxyStickyParamName,
        rotationCooldownMs: this.config.cliproxyRotationCooldownMs,
      });
      await this.proxyPool.assign();
      this.startProxyRefresh();
    }
  }

  async start(options = {}) {
    if (options.customLogDir) {
      this.config.customLogDir = options.customLogDir;
      this.logger = createBroadcastLogger([
        createStdoutLogger({ nodeCode: this.config.nodeCode }),
        createFileLogger({
          nodeCode: this.config.nodeCode,
          logDir: options.customLogDir,
        }),
      ]);
    }
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

    let imageUploader = null;
    if (this.config.imageUploadUrl) {
      imageUploader = new ImageUploader({
        uploadUrl: this.config.imageUploadUrl,
        nodeCode: this.config.nodeCode,
        nodeToken: this.config.nodeToken,
        concurrency: this.config.imageUploadConcurrency,
        maxRetries: this.config.imageUploadRetries,
        retryDelays: [1000, 2000, 4000],
      });
    }

    this.worker = new Worker({
      pusher: this.pusher,
      imageUploader,
      log: this.log.bind(this),
      logger: this.logger,
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
    this.startHeartbeat();
    await this.startHealthServer();
    this.registerSignalHandlers();
  }

  async stop() {
    if (this.shuttingDown) return this.shutdownPromise;
    this.shuttingDown = true;
    this.log('[SERVICE] Shutting down gracefully...');

    this.stopHealthCheck();
    this.stopHeartbeat();
    this.stopProxyRefresh();
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }
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

  async startHealthServer() {
    if (this.healthServer || this.config.healthPort == null) {
      return;
    }

    this.healthServerStartTime = Date.now();

    this.healthServer = http.createServer(async (req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not found' }));
        return;
      }

      const browserConnected = this.browser && this.browser.isConnected();
      const status = browserConnected ? 'ok' : 'degraded';
      const code = browserConnected ? 200 : 503;

      const channels = await Promise.all(this.channels.map(async (c) => ({
        id: c.id,
        healthy: await c.isHealthy(),
        proxy: maskProxyUrl(
          this.proxyPool
            ? this.proxyPool.getProxyForChannel(`ch-${c.id}`)
            : this.config.proxy
        ),
      })));

      const queue = {
        pending: this.worker ? this.worker.taskQueue.length : 0,
        running: this.worker ? this.worker.channels.filter((c) => c.busy).length : 0,
        completed: 0,
      };

      const payload = {
        status,
        nodeCode: this.config.nodeCode,
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - this.healthServerStartTime) / 1000),
        browserConnected,
        channels,
        queue,
      };

      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });

    return new Promise((resolve, reject) => {
      this.healthServer.listen(this.config.healthPort, '0.0.0.0', () => {
        this.log(`[HEALTH] Server listening on port ${this.healthServer.address().port}`);
        resolve();
      });
      this.healthServer.on('error', reject);
    });
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const startedAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      this.logger.info('heartbeat', 'alive', {
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        channels: this.channels.length,
        pending: this.worker ? this.worker.taskQueue.length : 0,
        running: this.worker ? this.worker.channels.filter(c => c.busy).length : 0,
        browserConnected: this.browser ? this.browser.isConnected() : false,
      });
    }, (this.config.heartbeatInterval || 30) * 1000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async checkChannelForRotation(channel) {
    if (channel.busy) {
      return;
    }

    const healthy = await channel.isHealthy();
    const proxyFailed = channel.consecutiveFailures >= 2 && channel.lastFailureWasProxy;
    const dataLayerRequiresRotation = channel.needsProxyRotation();
    if (!healthy || proxyFailed || dataLayerRequiresRotation) {
      if (proxyFailed) {
        this.log(`[SERVICE] Channel ${channel.id} has ${channel.consecutiveFailures} consecutive proxy failures, rotating proxy`);
      } else if (dataLayerRequiresRotation) {
        this.log(`[SERVICE] Channel ${channel.id} has ${channel.dataLayerFailureCount} consecutive dataLayer failures, rotating proxy`);
      } else {
        this.log(`[SERVICE] Channel ${channel.id} unhealthy detected`);
      }
      if (this.proxyPool) {
        try {
          channel.reinitializing = true;
          const channelId = `ch-${channel.id}`;
          const newProxy = await this.proxyPool.nextForChannel(channelId);
          this.log(`[SERVICE] Rotating channel ${channel.id} to ${newProxy}`);
          channel.consecutiveFailures = 0;
          channel.lastFailureWasProxy = false;
          channel.dataLayerFailureCount = 0;
          await channel.reinit(this.browser, newProxy);
          // 记录 IP 轮换时间戳，让 channel.maybeTriggerReinstall 知道当前处于 cooldown
          channel.recordIpRotation();
          const stillUnhealthy = !(await channel.isHealthy());
          if (!stillUnhealthy) {
            this.log(`[SERVICE] Channel ${channel.id} recovered after proxy rotation`);
            return;
          }
        } catch (e) {
          this.log(`[SERVICE] Proxy rotation failed for channel ${channel.id}:`, e.message);
        } finally {
          channel.reinitializing = false;
        }
      }
      await this.restartBrowser();
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
      await this.checkChannelForRotation(channel);
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

        if (this.shuttingDown) {
          this.log('[SERVICE] Shutdown in progress, aborting browser restart');
          return;
        }

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

        if (this.shuttingDown) {
          this.log('[SERVICE] Shutdown in progress, aborting browser restart');
          return;
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
