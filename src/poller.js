const JSONbig = require('json-bigint')({ useNativeBigInt: true });

function toTaskId(value) {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    // Use BigInt for all numeric ids to avoid any precision loss,
    // regardless of whether they currently fit in a safe integer.
    return BigInt(value);
  }
  // Strings are preserved as-is so the callback mirrors the upstream type.
  return value;
}

class Poller {
  constructor(options) {
    this.taskUrl = options.taskUrl;
    this.nodeCode = options.nodeCode;
    this.nodeToken = options.nodeToken || '';
    this.limit = options.limit || 10;
    this.pollInterval = options.pollInterval || 5000;
    this.fetch = options.fetch || globalThis.fetch;
    this.running = false;
    this.timer = null;
  }

  async fetchTasks() {
    const response = await this.fetch(this.taskUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nodeCode: this.nodeCode,
        nodeToken: this.nodeToken,
        limit: this.limit,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Fetch tasks failed: ${response.status} ${text}`);
    }

    let data;
    let responseText = '';
    try {
      responseText = await response.text();
      data = JSONbig.parse(responseText);
    } catch (e) {
      throw new Error(`Fetch tasks returned invalid JSON: ${e.message}. Body: ${responseText}`);
    }

    return (Array.isArray(data.data) ? data.data : []).map((task) => {
      // The real upstream API uses `id` as the task identifier.
      // Normalize it to `crawlerTaskId` for downstream consumers.
      // String ids are converted to BigInt so the callback body can serialize
      // them as JSON numbers without losing precision.
      if (task && task.crawlerTaskId !== undefined) {
        return { ...task, crawlerTaskId: toTaskId(task.crawlerTaskId) };
      }
      if (task && task.id !== undefined) {
        return { ...task, crawlerTaskId: toTaskId(task.id) };
      }
      return task;
    });
  }

  start(onTasks) {
    if (this.running) return;
    this.running = true;

    const tick = async () => {
      if (!this.running) return;
      try {
        const tasks = await this.fetchTasks();
        if (tasks.length > 0) {
          console.log(`[Poller] fetched ${tasks.length} task(s), ids: ${tasks.map(t => t.crawlerTaskId || t.id || 'undefined').join(', ')}`);
          if (onTasks) {
            onTasks(tasks);
          }
        }
      } catch (e) {
        console.error('[Poller] Failed to fetch tasks:', e.message);
      }
      if (this.running) {
        this.timer = setTimeout(tick, this.pollInterval);
      }
    };

    tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { Poller };
