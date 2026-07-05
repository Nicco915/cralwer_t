const fs = require('fs');
const path = require('path');

function loadEnvFile(cwd) {
  const envPath = path.join(cwd || process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    // Docker 场景：env 已通过 env_file / environment 注入到 process.env，跳过文件加载
    return;
  }
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
  'browser-temp-dir': 'browserTempDir',
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
  'goto-max-retries': 'gotoMaxRetries',
  'goto-timeout': 'gotoTimeout',
  'goto-retry-delays': 'gotoRetryDelays',
  'headed-fallback': 'headedFallback',
  'page-refresh-after-tasks': 'pageRefreshAfterTasks',
  'data-layer-max-retries': 'dataLayerMaxRetries',
  'data-layer-failure-threshold': 'dataLayerFailureThreshold',
  'stealth-mode': 'stealthMode',
  'adaptive-timeout-threshold': 'adaptiveTimeoutThreshold',
  'adaptive-recovery-successes': 'adaptiveRecoverySuccesses',
  'adaptive-data-layer-threshold': 'adaptiveDataLayerThreshold',
  'data-layer-proxy-rotation-threshold': 'dataLayerProxyRotationThreshold',
  'cliproxy-rotation-cooldown-ms': 'cliproxyRotationCooldownMs',
  'kuaidaili-secret-id': 'kuaidailiSecretId',
  'kuaidaili-secret-key': 'kuaidailiSecretKey',
  'kuaidaili-proxy-type': 'kuaidailiProxyType',
  'kuaidaili-token-cache-file': 'kuaidailiTokenCacheFile',
  'kuaidaili-proxy-num': 'kuaidailiProxyNum',
  'proxy-machine-index': 'proxyMachineIndex',
  'proxy-machine-total': 'proxyMachineTotal',
  'proxy-refresh-interval-ms': 'proxyRefreshIntervalMs',
  'proxy-assignments-file': 'proxyAssignmentsFile',
  proxy: 'proxy',
  'image-upload-url': 'imageUploadUrl',
  'image-upload-concurrency': 'imageUploadConcurrency',
  'image-upload-retries': 'imageUploadRetries',
  'image-upload': 'enableImageUpload',
};

const BOOLEAN_FLAGS = new Set([
  'headless',
  'translate',
  'feishu',
  'headed-fallback',
  'image-upload',
]);

const BOOLEAN_CONFIG_KEYS = new Set([
  'headless',
  'enableTranslation',
  'enableFeishu',
  'headedFallback',
  'enableImageUpload',
]);

function isBooleanFlag(key) {
  return BOOLEAN_FLAGS.has(key);
}

function coerceValue(raw, configKey) {
  if (BOOLEAN_CONFIG_KEYS.has(configKey)) {
    return raw !== false && raw !== 'false' && raw !== '0' && raw !== '';
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

  // Parse gotoRetryDelays if it's a string
  if (typeof config.gotoRetryDelays === 'string') {
    const trimmed = config.gotoRetryDelays.trim();
    if (trimmed) {
      config.gotoRetryDelays = trimmed.split(',').map(v => Number(v.trim())).filter(v => !isNaN(v));
    } else {
      config.gotoRetryDelays = [3000, 6000, 12000];
    }
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
    CRAWLER_BROWSER_TEMP_DIR: 'browserTempDir',
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
    CRAWLER_HEALTH_PORT: 'healthPort',
    CRAWLER_NODE_CODE: 'nodeCode',
    CRAWLER_NODE_TOKEN: 'nodeToken',
    CRAWLER_TASK_URL: 'taskUrl',
    CRAWLER_CALLBACK_URL: 'callbackUrl',
    CRAWLER_CHANNELS: 'channels',
    CRAWLER_POLL_INTERVAL: 'pollInterval',
    CRAWLER_POLL_LIMIT: 'pollLimit',
    CRAWLER_PUSH_RETRIES: 'pushRetries',
    CRAWLER_GOTO_MAX_RETRIES: 'gotoMaxRetries',
    CRAWLER_GOTO_TIMEOUT: 'gotoTimeout',
    CRAWLER_GOTO_RETRY_DELAYS: 'gotoRetryDelays',
    CRAWLER_HEADED_FALLBACK: 'headedFallback',
    CRAWLER_PAGE_REFRESH_AFTER_TASKS: 'pageRefreshAfterTasks',
    CRAWLER_DATA_LAYER_MAX_RETRIES: 'dataLayerMaxRetries',
    CRAWLER_DATA_LAYER_FAILURE_THRESHOLD: 'dataLayerFailureThreshold',
    KUAIDAILI_SECRET_ID: 'kuaidailiSecretId',
    KUAIDAILI_SECRET_KEY: 'kuaidailiSecretKey',
    KUAIDAILI_PROXY_TYPE: 'kuaidailiProxyType',
    KUAIDAILI_PROXY_NUM: 'kuaidailiProxyNum',
    KUAIDAILI_TOKEN_CACHE_FILE: 'kuaidailiTokenCacheFile',
    PROXY_MACHINE_INDEX: 'proxyMachineIndex',
    PROXY_MACHINE_TOTAL: 'proxyMachineTotal',
    PROXY_REFRESH_INTERVAL_MS: 'proxyRefreshIntervalMs',
    PROXY_ASSIGNMENTS_FILE: 'proxyAssignmentsFile',
    CRAWLER_PROXY: 'proxy',
    CLIPROXY_HOST: 'cliproxyHost',
    CLIPROXY_PORT: 'cliproxyPort',
    CLIPROXY_USERNAME: 'cliproxyUsername',
    CLIPROXY_PASSWORD: 'cliproxyPassword',
    CLIPROXY_REGION: 'cliproxyRegion',
    CLIPROXY_ASN: 'cliproxyAsn',
    CLIPROXY_STICKY_MINUTES: 'cliproxyStickyMinutes',
    CRAWLER_CLIPROXY_SESSION_PREFIX: 'cliproxySessionPrefix',
    CLIPROXY_SESSION_PREFIX: 'cliproxySessionPrefix',
    CLIPROXY_ASSIGNMENTS_FILE: 'cliproxyAssignmentsFile',
    CLIPROXY_REGION_PARAM_NAME: 'cliproxyRegionParamName',
    CLIPROXY_ASN_PARAM_NAME: 'cliproxyAsnParamName',
    CLIPROXY_SESSION_PARAM_NAME: 'cliproxySessionParamName',
    CLIPROXY_STICKY_PARAM_NAME: 'cliproxyStickyParamName',
    CRAWLER_IMAGE_UPLOAD_URL: 'imageUploadUrl',
    CRAWLER_IMAGE_UPLOAD_CONCURRENCY: 'imageUploadConcurrency',
    CRAWLER_IMAGE_UPLOAD_RETRIES: 'imageUploadRetries',
    CRAWLER_IMAGE_UPLOAD: 'enableImageUpload',
    CRAWLER_STEALTH_MODE: 'stealthMode',
    CRAWLER_USER_AGENT: 'userAgent',
    CRAWLER_ADAPTIVE_TIMEOUT_THRESHOLD: 'adaptiveTimeoutThreshold',
    CRAWLER_ADAPTIVE_RECOVERY_SUCCESSES: 'adaptiveRecoverySuccesses',
    CRAWLER_ADAPTIVE_DATA_LAYER_THRESHOLD: 'adaptiveDataLayerThreshold',
    CRAWLER_DATA_LAYER_PROXY_ROTATION_THRESHOLD: 'dataLayerProxyRotationThreshold',
    CRAWLER_CLIPROXY_ROTATION_COOLDOWN_MS: 'cliproxyRotationCooldownMs',
  };
  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey] !== undefined && config[configKey] === undefined) {
      config[configKey] = coerceValue(process.env[envKey], configKey);
    }
  }

  return config;
}

module.exports = { loadEnvFile, parse };
