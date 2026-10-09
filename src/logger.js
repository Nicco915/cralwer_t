const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_LOG_RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 轮转文件命名：crawler-YYYYMMDD-HHMMSS(-seq).jsonl
const ROTATED_LOG_PATTERN = /^crawler-\d{8}-\d{6}(-\d+)?\.jsonl$/;

function getCircularReplacer() {
  const seen = new WeakSet();
  return (key, value) => {
    // poller.js 把数值型任务 id 转成原生 BigInt 防精度丢失；
    // 普通 JSON.stringify 遇到 BigInt 直接抛错，导致整条日志被 broadcast 吞掉。
    // 安全整数转 number，超出精度范围的转字符串（与 pusher 回调体的字符串语义一致）。
    if (typeof value === 'bigint') {
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

function createLogger(options = {}) {
  const nodeCode = options.nodeCode || 'unknown';
  const write = options.write || ((line) => process.stdout.write(line));

  function log(level, component, msg, extra = {}) {
    const entry = {
      ...extra,
      time: new Date().toISOString(),
      level,
      component,
      msg: msg === undefined ? null : msg,
      nodeCode,
    };
    write(JSON.stringify(entry, getCircularReplacer()) + '\n');
  }

  return {
    info: (component, msg, extra) => log('INFO', component, msg, extra),
    warn: (component, msg, extra) => log('WARN', component, msg, extra),
    error: (component, msg, extra) => log('ERROR', component, msg, extra),
  };
}

function rotatedLogName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `crawler-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jsonl`;
}

function cleanupRotatedLogs(logDir, retentionDays) {
  if (!retentionDays || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(logDir);
  } catch (err) {
    process.stderr.write(`[LOGGER] Log cleanup readdir error: ${err.message}\n`);
    return;
  }
  for (const name of entries) {
    if (!ROTATED_LOG_PATTERN.test(name)) continue;
    const filePath = path.join(logDir, name);
    try {
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      process.stderr.write(`[LOGGER] Log cleanup error for ${name}: ${err.message}\n`);
    }
  }
}

function createFileLogger(options = {}) {
  const logDir = options.logDir || path.resolve('./logs');
  const maxBytes = options.maxBytes !== undefined ? Number(options.maxBytes) : DEFAULT_LOG_MAX_BYTES;
  const retentionDays = options.retentionDays !== undefined ? Number(options.retentionDays) : DEFAULT_LOG_RETENTION_DAYS;
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'crawler.jsonl');

  // 以已有文件大小初始化计数，进程重启后不会丢失已写入的量。
  let bytesWritten = 0;
  try {
    if (fs.existsSync(logFile)) {
      bytesWritten = fs.statSync(logFile).size;
    }
  } catch (err) {
    process.stderr.write(`[LOGGER] Log stat error: ${err.message}\n`);
  }

  function rotate() {
    try {
      if (!fs.existsSync(logFile)) return;
      let rotated = path.join(logDir, rotatedLogName());
      // 同一秒内多次轮转时追加序号避免覆盖。
      let seq = 1;
      while (fs.existsSync(rotated)) {
        rotated = path.join(logDir, rotatedLogName().replace(/\.jsonl$/, `-${seq}.jsonl`));
        seq += 1;
      }
      fs.renameSync(logFile, rotated);
      bytesWritten = 0;
    } catch (err) {
      process.stderr.write(`[LOGGER] Log rotate error: ${err.message}\n`);
    }
  }

  cleanupRotatedLogs(logDir, retentionDays);
  // 低流量节点也要定期清理过期轮转文件；unref 避免阻止进程退出。
  const cleanupTimer = setInterval(() => cleanupRotatedLogs(logDir, retentionDays), CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return createLogger({
    nodeCode: options.nodeCode,
    write: (line) => {
      try {
        if (maxBytes > 0 && bytesWritten + Buffer.byteLength(line) > maxBytes) {
          rotate();
        }
        fs.appendFileSync(logFile, line);
        bytesWritten += Buffer.byteLength(line);
      } catch (err) {
        process.stderr.write(`[LOGGER] File write error: ${err.message}\n`);
      }
    },
  });
}

function createStdoutLogger(options = {}) {
  const nodeCode = options.nodeCode || 'unknown';
  const write = options.write || ((line) => process.stdout.write(line));
  return createLogger({ nodeCode, write });
}

function createBroadcastLogger(loggers) {
  const safeCall = (method, args) => {
    for (const l of loggers) {
      try { l[method](...args); } catch (e) {
        process.stderr.write(`[BROADCAST-LOGGER] ${method} failed: ${e.message}\n`);
      }
    }
  };
  return {
    info: (c, m, e) => safeCall('info', [c, m, e]),
    warn: (c, m, e) => safeCall('warn', [c, m, e]),
    error: (c, m, e) => safeCall('error', [c, m, e]),
  };
}

module.exports = { createLogger, createFileLogger, createStdoutLogger, createBroadcastLogger, cleanupRotatedLogs };
