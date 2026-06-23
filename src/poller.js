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
    try {
      data = await response.json();
    } catch (e) {
      const text = await response.text().catch(() => '');
      throw new Error(`Fetch tasks returned invalid JSON: ${e.message}. Body: ${text}`);
    }

    return Array.isArray(data.data) ? data.data : [];
  }

  start(onTasks) {
    if (this.running) return;
    this.running = true;

    const tick = async () => {
      if (!this.running) return;
      try {
        const tasks = await this.fetchTasks();
        if (tasks.length > 0 && onTasks) {
          onTasks(tasks);
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
