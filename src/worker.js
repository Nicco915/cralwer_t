class Worker {
  constructor(options) {
    this.channels = [];
    this.taskQueue = [];
    this.pusher = options.pusher;
    this.log = options.log || console.log;
    this.running = false;
    this.pendingPushes = new Set();
    this.loopPromise = null;
    this.maxQueueSize = options.maxQueueSize || 50;
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
    const toAdd = tasks.slice(0, available);
    for (const task of toAdd) {
      this.taskQueue.push(task);
    }
    this.log(`[Worker] queued ${toAdd.length}/${tasks.length} task(s), total pending: ${this.taskQueue.length}`);
  }

  getIdleChannel() {
    return this.channels.find(c => !c.busy);
  }

  async runTask(task, channel) {
    const pushPromise = (async () => {
      let result = null;
      try {
        this.log(`[Worker] Assigning task ${task.crawlerTaskId} sku ${task.sku} to channel ${channel.id}`);
        result = await channel.crawl(task);
        this.log(`[Worker] Crawl finished task ${task.crawlerTaskId} status ${result.status}`);
      } catch (e) {
        this.log(`[Worker] Crawl failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        result = {
          crawlerTaskId: task.crawlerTaskId,
          sku: task.sku,
          status: 'error',
          product_name: '',
          features_details: '',
          product_specification: '',
          product_url: '',
          error: e.message,
        };
      }

      try {
        this.log(`[Worker] Starting push task ${task.crawlerTaskId} sku ${task.sku} status=${result.status}`);
        await this.pusher.push(result);
        this.log(`[Worker] Push completed task ${task.crawlerTaskId} status ${result.status}`);
      } catch (e) {
        this.log(`[Worker] Push failed task ${task.crawlerTaskId} sku ${task.sku}: ${e.message}`);
        try {
          await this.pusher.push({
            crawlerTaskId: task.crawlerTaskId,
            sku: task.sku,
            status: 'error',
            product_name: '',
            features_details: '',
            product_specification: '',
            product_url: '',
            error: e.message,
          });
          this.log(`[Worker] Error status pushed for task ${task.crawlerTaskId}`);
        } catch (pushErr) {
          this.log(`[Worker] failed to push error result for task ${task.crawlerTaskId}: ${pushErr.message}`);
        }
      }
    })();

    this.pendingPushes.add(pushPromise);
    pushPromise.finally(() => this.pendingPushes.delete(pushPromise));
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
    while (this.taskQueue.length > 0 || this.channels.some(c => c.busy) || this.pendingPushes.size > 0) {
      this.log(`[Worker] draining: queue=${this.taskQueue.length}, busy=${this.channels.filter(c => c.busy).length}, pushes=${this.pendingPushes.size}`);
      await this.sleep(500);
    }
  }
}

module.exports = { Worker };
