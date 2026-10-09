const fs = require('fs');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendPusherLog(record) {
  const logDir = path.resolve(process.cwd(), 'logs');
  ensureDir(logDir);
  const logFile = path.join(logDir, 'pusher.log');

  // Simple size-based rotation: keep pusher.log under ~10 MB.
  try {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 10 * 1024 * 1024) {
        const rotated = `${logFile}.1`;
        if (fs.existsSync(rotated)) {
          fs.unlinkSync(rotated);
        }
        fs.renameSync(logFile, rotated);
      }
    }
  } catch (e) {
    console.error(`[PUSHER] Failed to rotate pusher.log: ${e.message}`);
  }

  const line = `${formatTimestamp()} ${JSONbig.stringify(record)}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (e) {
    console.error(`[PUSHER] Failed to append pusher.log: ${e.message}`);
  }
}

function writeCallbackBody(taskId, body) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateDir = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const callbackDir = path.resolve(process.cwd(), 'logs', 'callbacks', dateDir);
  ensureDir(callbackDir);
  const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${safeId}.json`;
  const filePath = path.join(callbackDir, fileName);
  try {
    fs.writeFileSync(filePath, JSONbig.stringify(body, null, 2));
    return filePath;
  } catch (e) {
    console.error(`[PUSHER] Failed to write callback body file: ${e.message}`);
    return null;
  }
}

// 清理 logs/callbacks/ 下超过保留天数的日期目录（目录名 YYYY-MM-DD）。
function cleanupOldCallbacks(retentionDays, baseDir = process.cwd()) {
  if (!retentionDays || retentionDays <= 0) return;
  const callbacksRoot = path.resolve(baseDir, 'logs', 'callbacks');
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(callbacksRoot);
  } catch (e) {
    return; // 目录不存在等情况无需清理
  }
  for (const name of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const dirPath = path.join(callbacksRoot, name);
    try {
      const stats = fs.statSync(dirPath);
      // 用目录 mtime 与目录名日期双重判断，都过期才删除，避免误删
      const dirDate = new Date(`${name}T00:00:00`).getTime();
      if (stats.mtimeMs < cutoff && dirDate < cutoff) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`[PUSHER] Failed to clean callbacks dir ${name}: ${e.message}`);
    }
  }
}

class Pusher {
  constructor(options) {
    this.callbackUrl = options.callbackUrl;
    this.nodeCode = options.nodeCode;
    this.nodeToken = options.nodeToken || '';
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.retentionDays = options.retentionDays !== undefined ? options.retentionDays : 7;
    this.lastCallbackCleanup = 0;
    cleanupOldCallbacks(this.retentionDays);
    this.fetch = options.fetch || globalThis.fetch;
  }

  buildBody(result) {
    const isSuccess = result.status === 'success';
    return {
      crawlerTaskId: result.crawlerTaskId,
      sku: result.sku,
      regionCode: result.regionCode || '',
      nodeCode: this.nodeCode,
      nodeToken: this.nodeToken,
      goodsName: result.product_name || '',
      goodsDesc: result.features_details || '',
      sourceUrl: result.product_url || '',
      rawContent: result.product_specification || '',
      success: isSuccess,
      errorMessage: result.error || '',
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async push(result) {
    // 每小时最多清理一次过期回调审计目录（构造时已做过首次清理）
    if (Date.now() - this.lastCallbackCleanup > 60 * 60 * 1000) {
      this.lastCallbackCleanup = Date.now();
      cleanupOldCallbacks(this.retentionDays);
    }
    const body = this.buildBody(result);
    const taskId = result.crawlerTaskId;
    let lastError = null;

    const bodyPath = writeCallbackBody(taskId, body);
    appendPusherLog({ level: 'info', taskId, sku: result.sku, status: result.status, callbackUrl: this.callbackUrl, bodyPath, event: 'start' });

    console.log(`[PUSHER] Start pushing task ${taskId} sku ${result.sku} status=${result.status} to ${this.callbackUrl}`);
    console.log(`[PUSHER] Body ${taskId}: ${JSONbig.stringify(body)}`);
    if (bodyPath) {
      console.log(`[PUSHER] Body file ${taskId}: ${bodyPath}`);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`[PUSHER] Retrying task ${taskId}, attempt ${attempt}/${this.maxRetries}`);
        appendPusherLog({ level: 'info', taskId, sku: result.sku, attempt, event: 'retry' });
      }
      try {
        const response = await this.fetch(this.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSONbig.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Callback failed: ${response.status} ${text}`);
        }

        console.log(`[PUSHER] Success task ${taskId}, response=${response.status}`);
        appendPusherLog({ level: 'info', taskId, sku: result.sku, responseStatus: response.status, event: 'success' });
        return;
      } catch (e) {
        lastError = e;
        console.error(`[PUSHER] Failed task ${taskId} attempt ${attempt}: ${e.message}`);
        appendPusherLog({ level: 'error', taskId, sku: result.sku, attempt, error: e.message, event: 'failed' });
        if (attempt < this.maxRetries) {
          const delay = this.retryDelays[attempt] || 4000;
          await this.sleep(delay);
        }
      }
    }

    appendPusherLog({ level: 'error', taskId, sku: result.sku, error: lastError?.message, event: 'exhausted' });
    throw lastError || new Error('Callback failed after retries');
  }
}

module.exports = { Pusher, cleanupOldCallbacks };
