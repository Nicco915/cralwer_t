class TaskDeadlineError extends Error {
  constructor(timeoutMs) {
    super(`Task deadline ${timeoutMs}ms exceeded`);
    this.code = 'TASK_DEADLINE_EXCEEDED';
    this.timeoutMs = timeoutMs;
  }
}

const { classifyGotoError } = require('./page-crawler');
const verdict = require('./result-verdict');
const { ERROR_CODES } = verdict;

const NO_RESULT_FALLBACKS = {
  GB: 'US',
  EU: 'US',
  CA: 'US',
};

class Worker {
  constructor(options) {
    this.channels = [];
    this.taskQueue = [];
    this.pusher = options.pusher;
    this.regionRegistry = options.regionRegistry || null;
    this.imageUploader = options.imageUploader || null;
    this.log = options.log || console.log;
    this.logger = options.logger || null;
    this.running = false;
    this.loopPromise = null;
    this.maxQueueSize = options.maxQueueSize || 50;
    this.inFlightTaskIds = new Set();
    this.retryOnTimeout = options.retryOnTimeout !== false;
    this.taskTimeoutMs = (options && options.taskTimeoutMs) || 200000;
  }

  // 决定是否对单 task 触发换 IP 重试。
  // 触发条件：业务异常强信号（dataLayer 异常 / page.goto 全 timeout / crawl timeout）
  // 不触发：业务无结果（dataLayerNotFound=true）/ 成功 / 普通 error / channel 正在重建 / 全局开关关闭
  // 判定语义收拢在 result-verdict（docs/plan-信号重构-阶段1.md）。
  // 到达这里的 error result 必带 errorCode：crawlSingleSku 通用 catch 与
  // buildErrorResult 双产出点打码（阶段 2 PR-4），无码兼容兜底已删除。
  shouldRetryWithNewIp(result, channel) {
    if (this.retryOnTimeout === false) return false;
    if (!channel || channel.reinitializing) return false;
    return verdict.shouldRetryWithNewIp(result);
  }

  getTaskIdKey(task) {
    const taskId = task.crawlerTaskId ?? task.id;
    return taskId !== undefined ? String(taskId) : null;
  }

  buildErrorResult(task, err) {
    const result = {
      crawlerTaskId: task.crawlerTaskId,
      sku: task.sku,
      regionCode: task.regionCode,
      status: err.status ?? 'error',
      product_name: '',
      features_details: '',
      product_specification: '',
      product_url: '',
      error: err.message,
    };
    // timeout 双产地打码：任务整体 deadline 兜底 vs page.goto 单次超时，
    // 运维含义不同（前者任务卡死/慢代理，后者坏出口信号），用码区分。
    if (err.code === 'TASK_DEADLINE_EXCEEDED') {
      result.errorCode = ERROR_CODES.TASK_DEADLINE_EXCEEDED;
    } else if (err.status === 'timeout' || verdict.isTimeoutError(err)) {
      result.errorCode = ERROR_CODES.GOTO_TIMEOUT;
    } else {
      // 非 timeout 异常同样在产出点打码（与 page-crawler 通用 catch 同一
      // classifyGotoError 映射）：channel 抛出的非 timeout 异常（如无 headed
      // 回退时的 net::ERR）经此变为带码 result，使 shouldRetryWithNewIp 的
      // 无码兜底成为死路径并于阶段 2 PR-4 删除。与旧兜底行为逐案等价：
      // retryable/proxy → 换 IP（true），non-retryable → 不换（false）。
      const category = classifyGotoError(err);
      if (category === 'proxy') {
        result.errorCode = ERROR_CODES.PROXY_CONNECTION_FAILED;
      } else if (category === 'retryable') {
        result.errorCode = ERROR_CODES.NAVIGATION_FAILED_RETRYABLE;
      } else {
        result.errorCode = ERROR_CODES.UNEXPECTED_ERROR;
      }
    }
    return result;
  }

  hasCapacity() {
    return this.taskQueue.length === 0 && this.channels.some(c => !c.busy);
  }

  addChannel(channel) {
    this.channels.push(channel);
  }

  resetChannels() {
    this.channels = [];
  }

  pushTasks(tasks) {
    const available = this.maxQueueSize - this.taskQueue.length;
    if (available <= 0) {
      this.log(`[Worker] queue full, dropped ${tasks.length} task(s)`);
      return;
    }

    const toAdd = [];
    for (const task of tasks.slice(0, available)) {
      const taskIdKey = this.getTaskIdKey(task);
      if (taskIdKey !== null && this.inFlightTaskIds.has(taskIdKey)) {
        this.log(`[Worker] skipping duplicate task ${task.crawlerTaskId ?? task.id}`);
        continue;
      }
      toAdd.push(task);
      if (taskIdKey !== null) {
        this.inFlightTaskIds.add(taskIdKey);
      }
    }

    for (const task of toAdd) {
      this.taskQueue.push(task);
    }
    this.log(`[Worker] queued ${toAdd.length}/${tasks.length} task(s), total pending: ${this.taskQueue.length}`);
  }

  getIdleChannel() {
    return this.channels.find(c => !c.busy && !c.reinitializing);
  }

  async runTask(task, channel) {
    const taskIdKey = this.getTaskIdKey(task);
    const startedAt = Date.now();
    let retries = 0;
    let result = null;
    let timedOut = false;
    let cancelled = false;

    // 多区域路由：把 task.regionCode 解析成 task.baseUrl。
    // 未知码/禁用码 → 快速失败回推，不占用通道、不崩节点。
    if (this.regionRegistry) {
      const reg = this.regionRegistry;
      const code = reg.normalize(task.regionCode);
      task.regionCode = code;
      const baseUrl = reg.resolve(code);
      if (baseUrl === null) {
        const disabled = reg.isKnown(code);
        const message = disabled
          ? `region ${code} has no target site (disabled)`
          : `unknown regionCode: ${code}`;
        result = this.buildErrorResult(task, new Error(message));
        this.log(`[Worker] task ${task.crawlerTaskId} rejected before crawl: ${message}`);
        try {
          await this.pusher.push(result);
        } catch (pushErr) {
          this.log(`[Worker] push failed for rejected task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
        if (taskIdKey !== null) {
          this.inFlightTaskIds.delete(taskIdKey);
        }
        if (this.logger) {
          try {
            this.logger.info('task', 'finished', {
              crawlerTaskId: task.crawlerTaskId,
              sku: task.sku,
              status: 'error',
              error: message,
              durationMs: Date.now() - startedAt,
              retries: 0,
              channelId: channel.id,
              timedOut: false,
              regionCode: code,
            });
          } catch (e) { /* ignore logger errors */ }
        }
        return result;
      }
      task.baseUrl = baseUrl;
    }
    channel.busy = true;

    // 完整流程（只包含 crawl + retry；push / upload 拆到 race 之后统一处理）
    const finishPromise = (async () => {
      if (cancelled) return result;
      try {
        this.log(`[Worker] Assigning task ${task.crawlerTaskId} sku ${task.sku} to channel ${channel.id}`);
        result = await channel.crawl(task);
        this.log(`[Worker] Crawl finished task ${task.crawlerTaskId} status ${result.status}`);
      } catch (e) {
        this.log(`[Worker] Crawl failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        result = this.buildErrorResult(task, e);
      }

      // 区域无结果兜底：UK/EU/CA 搜索页明确无结果时，到 US 站点再试一次。
      // 判定依据是机器可读的 errorCode（page-crawler 产出，经 verdict 判读），
      // 不依赖 error 文案，避免上游可见文案改动导致兜底静默失效。
      if (verdict.isRegionFallbackCandidate(result)) {
        const fallbackRegion = NO_RESULT_FALLBACKS[task.regionCode];
        if (fallbackRegion && this.regionRegistry) {
          const fallbackBaseUrl = this.regionRegistry.resolve(fallbackRegion);
          if (fallbackBaseUrl) {
            this.log(`[Worker] task ${task.crawlerTaskId} page shows no result on ${task.regionCode}, falling back to ${fallbackRegion}`);
            if (cancelled) {
              this.log(`[Worker] task ${task.crawlerTaskId} fallback cancelled: deadline already exceeded`);
              return result;
            }
            const fallbackTask = { ...task, baseUrl: fallbackBaseUrl };
            try {
              result = await channel.crawl(fallbackTask);
              this.log(`[Worker] Fallback crawl finished task ${task.crawlerTaskId} status ${result.status}`);
            } catch (fallbackErr) {
              this.log(`[Worker] Fallback crawl failed task ${task.crawlerTaskId}: ${fallbackErr.message}`);
              result = this.buildErrorResult(task, fallbackErr);
            }
          }
        }
      }

      // 换 IP 重试：针对 crawl 抛异常或返回异常 result 的场景
      if (this.shouldRetryWithNewIp(result, channel)) {
        if (cancelled) {
          this.log(`[Worker] task ${task.crawlerTaskId} retry cancelled: deadline already exceeded`);
          return result;
        }
        this.log(`[Worker] task ${task.crawlerTaskId} failed (${result.status}); rotating IP and retrying`);
        let rotated;
        try {
          rotated = await channel.rotateProxy('task-timeout');
        } catch (rotateErr) {
          this.log(`[Worker] rotateProxy failed task ${task.crawlerTaskId}: ${rotateErr.message}`);
          // 原任务已是 timeout 时保留原始 result，避免 rotate 失败覆盖 timeout 语义
          if (result.status === 'timeout') {
            return result;
          }
          result = this.buildErrorResult(task, rotateErr);
          return result;
        }
        if (rotated.rotated) {
          if (cancelled) return result;
          try {
            result = await channel.crawl(task);
            this.log(`[Worker] Retry crawl finished task ${task.crawlerTaskId} status ${result.status}`);
          } catch (retryErr) {
            this.log(`[Worker] Retry crawl failed task ${task.crawlerTaskId}: ${retryErr.message}`);
            result = this.buildErrorResult(task, retryErr);
          }
          retries = 1;
        } else if (rotated.reason === 'error') {
          this.log(`[Worker] rotate failed for task ${task.crawlerTaskId}: ${rotated.error}`);
          // 保留原始 result.status，仅追加 rotate 失败信息
          result = {
            ...result,
            error: `${result.error || ''}; rotate failed: ${rotated.error || rotated.reason}`.trim(),
          };
        } else {
          this.log(`[Worker] rotate skipped for task ${task.crawlerTaskId}: ${rotated.reason}`);
        }
      }

      return result;
    })();

    // Deadline 兜底：单 task 整体 crawl+retry 不超过 taskTimeoutMs（默认 200s）
    let deadlineReject;
    const deadlinePromise = new Promise((_, reject) => {
      deadlineReject = reject;
    });
    const deadlineTimer = setTimeout(
      () => {
        cancelled = true;
        deadlineReject(new TaskDeadlineError(this.taskTimeoutMs));
      },
      this.taskTimeoutMs,
    );

    try {
      result = await Promise.race([finishPromise, deadlinePromise]);
    } catch (err) {
      clearTimeout(deadlineTimer);
      if (err instanceof TaskDeadlineError || err.code === 'TASK_DEADLINE_EXCEEDED') {
        timedOut = true;
        this.log(`[Worker] Task ${task.crawlerTaskId} deadline exceeded, forcing timeout result`);
        // 任务令牌作废：channel 上仍在跑的僵尸 crawl 迟到完成时，
        // 不再触碰 channel 状态（计数/刷新/adaptive/currentTask）。
        if (typeof channel.cancelActiveCrawl === 'function') {
          try {
            channel.cancelActiveCrawl();
          } catch (cancelErr) {
            this.log(`[Worker] cancelActiveCrawl failed task ${task.crawlerTaskId}: ${cancelErr.message}`);
          }
        }
        // 显式兜底僵尸 Promise：迟到完成只打日志，不再有任何副作用；
        // rejection 在此吞掉，杜绝 unhandledRejection
        // （不再隐式依赖 Promise.race 内部 handler + finishPromise 全 try/catch 的现状）。
        const deadlineAt = Date.now();
        finishPromise.then(
          () => this.log(`[Worker] late completion dropped task ${task.crawlerTaskId} sku ${task.sku} (resolved ${Date.now() - deadlineAt}ms after deadline)`),
          (lateErr) => this.log(`[Worker] late completion dropped task ${task.crawlerTaskId} sku ${task.sku} (rejected ${Date.now() - deadlineAt}ms after deadline: ${lateErr && lateErr.message})`),
        );
        result = this.buildErrorResult(task, err);
        result.status = 'timeout';
        result.error = err.message;
        result.errorCode = ERROR_CODES.TASK_DEADLINE_EXCEEDED;
      } else {
        this.log(`[Worker] Task ${task.crawlerTaskId} failed with non-deadline error: ${err.message}`);
        result = this.buildErrorResult(task, err);
      }
    } finally {
      clearTimeout(deadlineTimer);
    }

    // 统一推送（包括 timeout）
    if (result) {
      result.regionCode = task.regionCode;
    }
    if (result) {
      try {
        this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
        await this.pusher.push(result);
        this.log(`[Worker] Push completed task ${task.crawlerTaskId} status ${result.status}`);

        if (this.imageUploader && result.status === 'success') {
          try {
            await this.imageUploader.upload(result);
            this.log(`[Worker] Image upload completed task ${task.crawlerTaskId} sku ${task.sku}`);
          } catch (uploadErr) {
            this.log(`[Worker] Image upload failed task ${task.crawlerTaskId} sku ${task.sku}: ${uploadErr.message}`);
          }
        }
      } catch (e) {
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        if (result.status === 'timeout') {
          this.log(`[Worker] Skipping fallback error push for already-timeout task ${task.crawlerTaskId}`);
        } else {
          retries = 1;  // 触发了 fallback error push
          const errorResult = {
            ...result,
            status: 'error',
            error: e.message,
          };
          try {
            await this.pusher.push(errorResult);
            this.log(`[Worker] Error status pushed for task ${task.crawlerTaskId}`);
          } catch (pushErr) {
            this.log(`[Worker] failed to push error result for task ${task.crawlerTaskId}: ${pushErr.message}`);
          }
          result = errorResult;  // 更新 result，让后续 logger 看到最终语义
        }
      }
    }

    // 资源清理（即使 deadline 触发也必须执行）
    channel.busy = false;
    if (taskIdKey !== null) {
      this.inFlightTaskIds.delete(taskIdKey);
    }

    // logger
    if (this.logger) {
      try {
        this.logger.info('task', timedOut ? 'timeout' : 'finished', {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: timedOut ? 'timeout' : (result?.status ?? 'unknown'),
          error: timedOut ? 'Task deadline exceeded' : (result?.error || ''),
          durationMs: Date.now() - startedAt,
          retries,
          channelId: channel.id,
          timedOut,
          regionCode: task.regionCode,
        });
      } catch (e) {
        this.log(`[Worker] Failed to write task event log: ${e.message}`);
      }
    }

    // deadline 路径不调 channel.onTaskComplete（避免二次卡死）
    if (!timedOut && channel.onTaskComplete) {
      try {
        await channel.onTaskComplete();
      } catch (e) {
        this.log(`[Worker] channel onTaskComplete error: ${e.message}`);
      }
    }

    return timedOut ? { ...task, status: 'timeout', error: 'Task deadline exceeded' } : result;
  }

  async loop() {
    while (this.running) {
      if (this.taskQueue.length > 0) {
        const channel = this.getIdleChannel();
        if (channel) {
          const task = this.taskQueue.shift();
          this.runTask(task, channel);
        }
      }
      await this.sleep(100);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  stop() {
    this.running = false;
  }

  async drain() {
    this.stop();
    if (this.loopPromise) {
      await this.loopPromise;
    }
    // 只等在途（busy）任务完成。不能等 taskQueue 清空：drain 的调用方
    // （service.stop / restartBrowser）在调用时 loop 已停，排队任务永远不会
    // 再被分发，等队列清空就是死锁（曾现网复现：draining: queue=1, busy=0
    // 死循环）。排队任务保留在队列里——restartBrowser 场景会在 worker.start()
    // 后分发到重启后的新 channel；service.stop 场景随进程退出由上游重派。
    while (this.channels.some(c => c.busy)) {
      this.log(`[Worker] draining: queue=${this.taskQueue.length}, busy=${this.channels.filter(c => c.busy).length}`);
      await this.sleep(500);
    }
  }
}

module.exports = { Worker };
