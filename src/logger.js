const fs = require('fs');
const path = require('path');

function createLogger(options = {}) {
  const nodeCode = options.nodeCode || 'unknown';
  const write = options.write || ((line) => process.stdout.write(line));

  function log(level, component, msg, extra = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      component,
      msg,
      nodeCode,
      ...extra,
    };
    write(JSON.stringify(entry) + '\n');
  }

  return {
    info: (component, msg, extra) => log('INFO', component, msg, extra),
    warn: (component, msg, extra) => log('WARN', component, msg, extra),
    error: (component, msg, extra) => log('ERROR', component, msg, extra),
  };
}

function createFileLogger(options = {}) {
  const logDir = options.logDir || path.resolve('./logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFile = path.join(logDir, 'crawler.jsonl');
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  return createLogger({
    nodeCode: options.nodeCode,
    write: (line) => stream.write(line),
  });
}

module.exports = { createLogger, createFileLogger };
