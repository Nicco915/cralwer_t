const fs = require('fs');
const path = require('path');

function getCircularReplacer() {
  const seen = new WeakSet();
  return (key, value) => {
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
