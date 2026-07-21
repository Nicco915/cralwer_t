const fs = require('fs');
const path = require('path');

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

function createFileLogger(options = {}) {
  const logDir = options.logDir || path.resolve('./logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'crawler.jsonl');
  return createLogger({
    nodeCode: options.nodeCode,
    write: (line) => {
      try {
        fs.appendFileSync(logFile, line);
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

module.exports = { createLogger, createFileLogger, createStdoutLogger, createBroadcastLogger };
