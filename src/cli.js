const fs = require('fs');
const path = require('path');

function loadEnvFile(cwd) {
  const envPath = path.join(cwd || process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const FLAG_MAP = {
  input: 'inputExcel',
  output: 'outputDir',
  'image-dir': 'imageDir',
  checkpoint: 'checkpointFile',
  result: 'resultPath',
  'base-url': 'baseUrl',
  order: 'order',
  headless: 'headless',
  'browser-path': 'browserPath',
  'min-delay': 'minDelay',
  'max-delay': 'maxDelay',
  'flush-interval': 'flushInterval',
  'test-count': 'testCount',
  translate: 'enableTranslation',
  'translate-model': 'dashscopeModel',
  feishu: 'enableFeishu',
  'feishu-to': 'feishuTo',
  'max-images': 'maxImages',
  'cloudflare-max-wait': 'cloudflareMaxWait',
  mode: 'mode',
  'node-code': 'nodeCode',
  'node-token': 'nodeToken',
  'task-url': 'taskUrl',
  'callback-url': 'callbackUrl',
  channels: 'channels',
  'poll-interval': 'pollInterval',
  'poll-limit': 'pollLimit',
  'push-retries': 'pushRetries',
};

const BOOLEAN_FLAGS = new Set([
  'headless',
  'translate',
  'feishu',
]);

const BOOLEAN_CONFIG_KEYS = new Set([
  'headless',
  'enableTranslation',
  'enableFeishu',
]);

function isBooleanFlag(key) {
  return BOOLEAN_FLAGS.has(key);
}

function coerceValue(raw, configKey) {
  if (BOOLEAN_CONFIG_KEYS.has(configKey)) {
    return raw !== false && raw !== 'false' && raw !== '0';
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function parse(rawArgs, defaults = {}) {
  const args = rawArgs || process.argv.slice(2);
  const config = { ...defaults };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    let key = arg.slice(2);
    let rawValue = true;

    if (key.startsWith('no-') && isBooleanFlag(key.slice(3))) {
      key = key.slice(3);
      rawValue = false;
    } else {
      const eqIndex = key.indexOf('=');
      if (eqIndex !== -1) {
        rawValue = key.slice(eqIndex + 1);
        key = key.slice(0, eqIndex);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        rawValue = args[i + 1];
        i++;
      }
    }

    const configKey = FLAG_MAP[key];
    if (!configKey) {
      throw new Error(`Unknown option: --${key}`);
    }

    config[configKey] = coerceValue(rawValue, configKey);
  }

  // Environment variable fallbacks (lowest precedence after explicit defaults)
  const envMap = {
    CRAWLER_INPUT: 'inputExcel',
    CRAWLER_OUTPUT: 'outputDir',
    CRAWLER_IMAGE_DIR: 'imageDir',
    CRAWLER_CHECKPOINT: 'checkpointFile',
    CRAWLER_RESULT: 'resultPath',
    CRAWLER_BASE_URL: 'baseUrl',
    CRAWLER_ORDER: 'order',
    CRAWLER_HEADLESS: 'headless',
    CRAWLER_BROWSER_PATH: 'browserPath',
    CRAWLER_MIN_DELAY: 'minDelay',
    CRAWLER_MAX_DELAY: 'maxDelay',
    CRAWLER_FLUSH_INTERVAL: 'flushInterval',
    CRAWLER_TEST_COUNT: 'testCount',
    CRAWLER_TRANSLATE: 'enableTranslation',
    DASHSCOPE_MODEL: 'dashscopeModel',
    CRAWLER_FEISHU: 'enableFeishu',
    CRAWLER_FEISHU_TO: 'feishuTo',
    CRAWLER_MAX_IMAGES: 'maxImages',
    CRAWLER_CLOUDFLARE_MAX_WAIT: 'cloudflareMaxWait',
    CRAWLER_MODE: 'mode',
    CRAWLER_NODE_CODE: 'nodeCode',
    CRAWLER_NODE_TOKEN: 'nodeToken',
    CRAWLER_TASK_URL: 'taskUrl',
    CRAWLER_CALLBACK_URL: 'callbackUrl',
    CRAWLER_CHANNELS: 'channels',
    CRAWLER_POLL_INTERVAL: 'pollInterval',
    CRAWLER_POLL_LIMIT: 'pollLimit',
    CRAWLER_PUSH_RETRIES: 'pushRetries',
  };

  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey] !== undefined && config[configKey] === undefined) {
      config[configKey] = coerceValue(process.env[envKey], configKey);
    }
  }

  return config;
}

module.exports = { loadEnvFile, parse };
