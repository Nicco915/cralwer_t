const { chromium } = require('playwright');
const { PageCrawler, classifyGotoError } = require('./page-crawler');
const { createProfile } = require('./stealth-profile');

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

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
    this.nodeCode = this.config.nodeCode || 'crawler-01';
    this.stealthMode = this.config.stealthMode || 'channel';
    this.effectiveStealthMode = this.stealthMode === 'adaptive' ? 'channel' : this.stealthMode;
    this.adaptiveTimeoutThreshold = this.config.adaptiveTimeoutThreshold !== undefined ? this.config.adaptiveTimeoutThreshold : 2;
    this.adaptiveRecoverySuccesses = this.config.adaptiveRecoverySuccesses !== undefined ? this.config.adaptiveRecoverySuccesses : 3;
    this.adaptiveDataLayerThreshold = this.config.adaptiveDataLayerThreshold !== undefined ? this.config.adaptiveDataLayerThreshold : 2;
    this.consecutiveTimeouts = 0;
    this.consecutiveSuccesses = 0;
    this.sessionIndex = 0;
    this.profile = this._createProfile();
    this.pageCrawler = new PageCrawler({
      baseUrl: this.config.baseUrl,
      imageDir: this.config.imageDir,
      diagnosticDir: this.config.diagnosticDir,
      userAgent: this.profile.userAgent,
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
    this.onTaskComplete = options.onTaskComplete || null;
    this.dataLayerFailureCount = 0;
    this.dataLayerFailureThreshold = this.config.dataLayerFailureThreshold !== undefined ? this.config.dataLayerFailureThreshold : 3;
    this.dataLayerProxyRotationThreshold = this.config.dataLayerProxyRotationThreshold !== undefined ? this.config.dataLayerProxyRotationThreshold : 2;
    this.profileStale = false;
    this.reinitializing = false;
    // 上次换 IP 的时间戳（毫秒）。0 表示从未换过。
    // 用于在 cliproxy cooldown 期内避免重复 reinstall（耗资源但 IP 没变）。
    this.lastIpRotationAt = 0;
    // 跨区域 cookie 护栏（默认关）：记录上次任务的区域，热切换时清 cookie 防串扰。
    this.lastRegionCode = null;
    this.clearCookiesOnRegionSwitch = this.config.clearCookiesOnRegionSwitch === true
      || this.config.clearCookiesOnRegionSwitch === 'true';
    this.browser = null;
    this.lastActivityAt = Date.now();
    // 代理池引用（由 Service.initChannels 注入），rotateProxy 换 IP 用。
    // 无池配置时为 null，rotateProxy 走 no_pool 分支。
    this.proxyPool = options.proxyPool || null;
  }

  _createProfile() {
    return createProfile({
      nodeCode: this.nodeCode,
      channelId: this.id,
      sessionIndex: this.sessionIndex,
      mode: this.effectiveStealthMode,
      fixedUserAgent: this.config.userAgent || null,
    });
  }

  _buildContextOptions() {
    const { userAgent, viewport, locale, timezoneId } = this.profile;
    const contextOptions = { userAgent, viewport, locale, timezoneId };
    if (this.config.proxy) {
      // Playwright/Chromium 在 Linux 下无法正确识别嵌在 URL 中的代理凭据，
      // 必须拆成 server / username / password 三个字段传递。
      let proxyUrl = this.config.proxy;
      if (!/^https?:\/\//i.test(proxyUrl)) {
        proxyUrl = `http://${proxyUrl}`;
      }
      const parsed = new URL(proxyUrl);
      const proxyConfig = {
        server: parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : `${parsed.protocol}//${parsed.hostname}`,
      };
      if (parsed.username) {
        proxyConfig.username = decodeURIComponent(parsed.username);
      }
      if (parsed.password) {
        proxyConfig.password = decodeURIComponent(parsed.password);
      }
      contextOptions.proxy = proxyConfig;
    }
    return contextOptions;
  }

  async recreateContext(browser) {
    this.browser = browser;
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (e) {
        // Ignore errors when context is already closed or browser is dead
      }
    }

    if (this.effectiveStealthMode === 'session') {
      this.sessionIndex += 1;
      this.profile = this._createProfile();
      this.pageCrawler.userAgent = this.profile.userAgent;
    }

    const contextOptions = this._buildContextOptions();

    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    return this.page;
  }

  updateAdaptiveState(status, isTimeout, dataLayerFailed) {
    if (this.stealthMode !== 'adaptive') {
      return;
    }

    const dataLayerStreakHit = dataLayerFailed && this.dataLayerFailureCount >= this.adaptiveDataLayerThreshold;

    if (isTimeout || dataLayerStreakHit) {
      this.consecutiveTimeouts += 1;
      this.consecutiveSuccesses = 0;
      if (this.consecutiveTimeouts >= this.adaptiveTimeoutThreshold && this.effectiveStealthMode !== 'session') {
        const reason = isTimeout ? 'timeouts' : 'dataLayer failures';
        this.log(`[Channel ${this.id}] Adaptive: switching to session mode after ${this.consecutiveTimeouts} consecutive ${reason}`);
        this.effectiveStealthMode = 'session';
        this.profileStale = true;
      }
      return;
    }

    this.consecutiveTimeouts = 0;

    if (status === 'success') {
      this.consecutiveSuccesses += 1;
      if (this.effectiveStealthMode === 'session' && this.consecutiveSuccesses >= this.adaptiveRecoverySuccesses) {
        this.log(`[Channel ${this.id}] Adaptive: switching back to channel mode after ${this.consecutiveSuccesses} consecutive successes`);
        this.effectiveStealthMode = 'channel';
        this.sessionIndex = 0;
        this.profile = this._createProfile();
        this.pageCrawler.userAgent = this.profile.userAgent;
        this.profileStale = true;
      }
    } else {
      // Other failures (not_found, sku_mismatch, error) do not count toward
      // recovery successes, but they also break the timeout streak.
      this.consecutiveSuccesses = 0;
    }
  }

  markActivity() {
    this.lastActivityAt = Date.now();
  }

  isIdleReclaimable(now, idleMs) {
    return !this.busy && !this.reinitializing && !!this.browserContext && (now - this.lastActivityAt) > idleMs;
  }

  async ensureContext() {
    const pageOpen = this.page && typeof this.page.isClosed === 'function' && !this.page.isClosed();
    if (this.browserContext && pageOpen) {
      return this.page;
    }
    if (!this.browser || !this.browser.isConnected()) {
      throw new Error('Browser not available for ensureContext');
    }
    if (this.browserContext) {
      try { await this.browserContext.close(); } catch (e) { /* already closed */ }
      this.browserContext = null;
      this.page = null;
    }
    const contextOptions = this._buildContextOptions();
    this.browserContext = await this.browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    this.log(`[Channel ${this.id}] context re-created after idle reclaim`);
    return this.page;
  }

  needsProxyRotation() {
    return this.dataLayerFailureCount >= this.dataLayerProxyRotationThreshold;
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
      const browser = this.browserContext.browser();
      if (browser && browser.isConnected()) {
        this.page = await this.browserContext.newPage();
      } else {
        // Browser disconnected: do not try to create a new page on a dead
        // context, which can hang indefinitely. Close the context and let the
        // service reinitialize the channel after restart.
        try {
          await this.browserContext.close();
        } catch (e) {
          // Ignore errors when context is already closed
        }
        this.browserContext = null;
        this.page = null;
      }
    }
    this.tasksSincePageRefresh = 0;
  }

  async refreshPageIfNeeded() {
    if (this.pageRefreshAfterTasks > 0 && this.tasksSincePageRefresh >= this.pageRefreshAfterTasks) {
      await this.refreshPage();
    }
  }

  getStealthScript() {
    return this.profile.stealthScript;
  }

  async init(browser, proxyOverride) {
    this.browser = browser;
    if (proxyOverride !== undefined) {
      this.config.proxy = proxyOverride;
    }
    const contextOptions = this._buildContextOptions();

    this.browserContext = await browser.newContext(contextOptions);
    await this.browserContext.addInitScript(this.getStealthScript());
    this.page = await this.browserContext.newPage();
    this.log(`[Channel ${this.id}] initialized`);
    this.markActivity();
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
      return await this.pageCrawler.crawlSingleSku(task.sku, headedPage, recreateContext, { baseUrl: task.baseUrl });
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
    this.currentTask = task;

    try {
      this.markActivity();
      await this.ensureContext();
      const taskRegion = task.regionCode || null;
      if (this.clearCookiesOnRegionSwitch && taskRegion && this.lastRegionCode
          && taskRegion !== this.lastRegionCode && this.browserContext) {
        await this.browserContext.clearCookies();
        this.log(`[Channel ${this.id}] region switch ${this.lastRegionCode} → ${taskRegion}, cookies cleared`);
      }
      if (taskRegion) {
        this.lastRegionCode = taskRegion;
      }
      const delay = this.pageCrawler.randomDelay();
      if (delay > 0) {
        this.log(`[Channel ${this.id}] waiting ${(delay / 1000).toFixed(1)}s before task ${task.crawlerTaskId}`);
        await this.pageCrawler.sleep(delay);
      }
      this.log(`[Channel ${this.id}] start task ${task.crawlerTaskId} sku ${task.sku}`);
      let result;
      let usedHeadedFallback = false;
      try {
        const recreateContext = async () => {
          const browser = this.browserContext ? this.browserContext.browser() : null;
          if (!browser) throw new Error('Browser context not available');
          return this.recreateContext(browser);
        };
        result = await this.pageCrawler.crawlSingleSku(task.sku, this.page, recreateContext, { baseUrl: task.baseUrl });
        if (result.dataLayerFailed && !result.dataLayerNotFound) {
          this.dataLayerFailureCount++;
          if (this.dataLayerFailureCount >= this.dataLayerFailureThreshold) {
            this.log(`[Channel ${this.id}] WARNING: dataLayer extraction failed for ${this.dataLayerFailureCount} consecutive tasks (threshold: ${this.dataLayerFailureThreshold}); possible network/IP/rendering issue`);
          }
        } else if (!result.dataLayerNotFound) {
          // 业务无结果（dataLayerNotFound=true）保留 dataLayerFailureCount 不变；
          // 真正的成功（或无 dataLayer 信号）才重置计数
          this.dataLayerFailureCount = 0;
        }
      } catch (e) {
        const isTimeout = e.name === 'TimeoutError' || (e.message && /Timeout \d+ms exceeded/.test(e.message));
        const isRetryableNetwork = classifyGotoError(e) === 'retryable' || (e.message && e.message.includes('net::ERR'));
        const isDataLayerError = e.message && (
          /^DATA_LAYER_NEVER_PUSHED/.test(e.message) ||
          /^DATA_LAYER_MISSING/.test(e.message) ||
          /^CF_CHALLENGE_UNRESOLVED/.test(e.message)
        );
        if ((isTimeout || isRetryableNetwork) && this.headedFallback && this.headedBrowserLauncher) {
          this.log(`[Channel ${this.id}] Headless request failed, trying headed fallback for task ${task.crawlerTaskId}`);
          result = await this.runHeadedFallback(task);
          usedHeadedFallback = true;
        } else if (isDataLayerError) {
          // dataLayer 异常通常意味着 IP/反爬问题，原地 retry 无效。
          // 翻译成 not_found 并累计 dataLayerFailureCount。
          // 受 cooldown 限制：cooldown 期内不再 reinstall（耗资源但 IP 没变），
          // 由 service.checkChannelForRotation 在 cooldown 解除后自动换 IP。
          this.log(`[Channel ${this.id}] ${e.message}; treating as not_found, requesting proxy rotation`);
          this.dataLayerFailureCount++;
          if (this.dataLayerFailureCount >= this.dataLayerFailureThreshold) {
            this.log(`[Channel ${this.id}] WARNING: dataLayer extraction failed for ${this.dataLayerFailureCount} consecutive tasks (threshold: ${this.dataLayerFailureThreshold}); possible network/IP/rendering issue`);
          }
          const cooldownMs = this.config.cliproxyRotationCooldownMs || 30000;
          const didReinstall = await this.maybeTriggerReinstall(cooldownMs);
          if (!didReinstall) {
            this.log(`[Channel ${this.id}] cooldown active, skipping reinstall (failures=${this.dataLayerFailureCount})`);
          }
          result = {
            sku: task.sku,
            product_name: '',
            product_url: '',
            features_details: '',
            product_specification: '',
            image_paths: '',
            status: 'not_found',
            error: e.message,
            dataLayerFailed: true,
            dataLayerNotFound: false,
          };
        } else {
          throw e;
        }
      }

      if (!usedHeadedFallback && result && result.status === 'error' && result.error) {
        const errMsg = result.error;
        const isNetworkError = errMsg.includes('net::ERR') || /Timeout \d+ms exceeded/.test(errMsg) || errMsg.includes('Navigation failed');
        if (isNetworkError && this.headedFallback && this.headedBrowserLauncher) {
          this.log(`[Channel ${this.id}] Headless page load failed, trying headed fallback for task ${task.crawlerTaskId}`);
          result = await this.runHeadedFallback(task);
        }
      }

      if (result && result.status === 'success') {
        this.dataLayerFailureCount = 0;
      }
      const isTimeoutResult = result && /Timeout \d+ms exceeded/.test(result.error || '');
      this.updateAdaptiveState(result ? result.status : 'error', isTimeoutResult, result && result.dataLayerFailed);
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
      this.updateAdaptiveState(e.status || 'error', isTimeout, false);
      throw e;
    } finally {
      this.currentTask = null;
      this.tasksSincePageRefresh++;
      try {
        await this.refreshPageIfNeeded();
      } catch (refreshErr) {
        this.log(`[Channel ${this.id}] page refresh failed: ${refreshErr.message}`);
      }
      if (this.profileStale) {
        try {
          const browser = this.browserContext ? this.browserContext.browser() : null;
          if (browser && browser.isConnected()) {
            await this.recreateContext(browser);
            this.profileStale = false;
          }
        } catch (e) {
          this.log(`[Channel ${this.id}] context recreate after adaptive switch failed: ${e.message}`);
        }
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
      // Verify the page context is actually usable by executing a trivial script.
      // Bound the wait with a timeout so a stuck renderer cannot drag health
      // checks forever (which would also hang /health HTTP clients).
      const timeoutMs = this.isHealthyTimeoutMs || 5000;
      await Promise.race([
        this.page.evaluate(() => document.title),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`isHealthy timeout after ${timeoutMs}ms`)),
          timeoutMs
        )),
      ]);
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

  // 由 service 在每次真正换 IP 后调用，记录时间戳。
  // DATA_LAYER_* 失败路径调用 maybeTriggerReinstall，会参考这个时间戳
  // 决定是否真的 reinstall（在 cooldown 内即使失败也不 reinstall）。
  recordIpRotation() {
    this.lastIpRotationAt = Date.now();
  }

  // 在 cooldown 期内失败时调用：返回 true 表示已 reinstall（cooldown 已过），
  // false 表示跳过 reinstall（cooldown 仍在，IP 不会变）。
  // 调用方应无条件递增 dataLayerFailureCount。
  async maybeTriggerReinstall(cooldownMs) {
    const now = Date.now();
    if (this.lastIpRotationAt > 0 && (now - this.lastIpRotationAt) < cooldownMs) {
      return false;
    }
    if (this.browserContext) {
      const browser = this.browserContext.browser();
      if (browser) {
        await this.reinit(browser);
        this.recordIpRotation();
        return true;
      }
    }
    // 没有 browser context（理论上不应发生），保守返回 false，
    // 让上层不要误以为已 reinstall。
    return false;
  }

  // 由 worker.runTask 在任务失败时调用：主动换 IP + session 后重试一次。
  // 返回 { rotated, reason } 让 caller 决定是否重试：
  //   - rotated=true: 已换 IP，可重试
  //   - rotated=false: 跳过换 IP（cooldown / 正在重建 / 无 pool / 错误），直接提交原 result
  // reason 字段用于日志和监控区分跳过原因。
  async rotateProxy(reason) {
    if (this.reinitializing) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: reinitializing`);
      return { rotated: false, reason: 'reinitializing' };
    }

    const cooldownMs = this.config.cliproxyRotationCooldownMs || 30000;
    const now = Date.now();
    if (this.lastIpRotationAt > 0 && (now - this.lastIpRotationAt) < cooldownMs) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: cooldown active (${Math.round((cooldownMs - (now - this.lastIpRotationAt)) / 1000)}s remaining)`);
      return { rotated: false, reason: 'cooldown' };
    }

    if (!this.proxyPool) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) skipped: no proxy pool`);
      return { rotated: false, reason: 'no_pool' };
    }

    try {
      this.reinitializing = true;

      const browser = this.browserContext ? this.browserContext.browser() : null;
      if (!browser || !browser.isConnected()) {
        this.log(`[Channel ${this.id}] rotateProxy(${reason}) failed: browser context not available or disconnected`);
        return { rotated: false, reason: 'error', error: 'Browser context not available or disconnected' };
      }

      const channelId = `ch-${this.id}`;
      const newProxy = await this.proxyPool.nextForChannel(channelId);
      this.log(`[Channel ${this.id}] rotateProxy(${reason}): rotating to ${maskProxyUrl(newProxy)}`);
      await this.reinit(browser, newProxy);
      this.recordIpRotation();
      return { rotated: true, reason: 'success' };
    } catch (e) {
      this.log(`[Channel ${this.id}] rotateProxy(${reason}) failed: ${e.message}`);
      return { rotated: false, reason: 'error', error: e.message };
    } finally {
      this.reinitializing = false;
    }
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
