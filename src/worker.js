class TaskDeadlineError extends Error {
  constructor(timeoutMs) {
    super(`Task deadline ${timeoutMs}ms exceeded`);
    this.code = 'TASK_DEADLINE_EXCEEDED';
    this.timeoutMs = timeoutMs;
  }
}

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
  shouldRetryWithNewIp(result, channel) {
    if (this.retryOnTimeout === false) return false;
    if (!channel || channel.reinitializing) return false;
    if (!result) return false;

    if (result.status === 'not_found' && result.dataLayerFailed === true && result.dataLayerNotFound !== true) {
      return true;
    }

    if (result.status === 'error' && typeof result.error === 'string' && /Timeout \d+ms exceeded/.test(result.error)) {
      return true;
    }

    if (result.status === 'timeout') {
      return true;
    }

    return false;
  }

  getTaskIdKey(task) {
    const taskId = task.crawlerTaskId ?? task.id;
    return taskId !== undefined ? String(taskId) : null;
  }

  buildErrorResult(task, err) {
    return {
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
        result = this.buildErrorResult(task, err);
        result.status = 'timeout';
        result.error = err.message;
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
    while (this.taskQueue.length > 0 || this.channels.some(c => c.busy)) {
      this.log(`[Worker] draining: queue=${this.taskQueue.length}, busy=${this.channels.filter(c => c.busy).length}`);
      await this.sleep(500);
    }
  }
}

module.exports = { Worker };
