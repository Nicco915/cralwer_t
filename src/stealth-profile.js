const crypto = require('crypto');

// LCG parameters from the Numerical Recipes "quick and dirty" generator.
// The modulus 233280 gives a full period for these multipliers, which is
// more than enough for header randomization where we only need a few draws.
const LCG_MULTIPLIER = 9301;
const LCG_INCREMENT = 49297;
const LCG_MODULUS = 233280;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

const HASH_PREFIX_LENGTH = 8;

const BUILTIN_DEVICE_MEMORY_POOL = [
  { v: 4, weight: 15 },
  { v: 8, weight: 50 },
  { v: 16, weight: 35 },
];

const BUILTIN_HARDWARE_CONCURRENCY_POOL = [
  { v: 4, weight: 15 },
  { v: 8, weight: 55 },
  { v: 12, weight: 20 },
  { v: 16, weight: 10 },
];

const BUILTIN_UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 30 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', weight: 20 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', weight: 15 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', weight: 10 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', weight: 8 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', weight: 5 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', weight: 5 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', weight: 4 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', weight: 2 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', weight: 1 },
];

const BUILTIN_LOCALE_POOL = [
  { locale: 'en-GB', timezoneId: 'Europe/London', languages: ['en-GB', 'en'], weight: 35 },
  { locale: 'en-US', timezoneId: 'America/New_York', languages: ['en-US', 'en'], weight: 25 },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', languages: ['de-DE', 'de'], weight: 15 },
  { locale: 'fr-FR', timezoneId: 'Europe/Paris', languages: ['fr-FR', 'fr'], weight: 10 },
  { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', languages: ['nl-NL', 'nl'], weight: 8 },
  { locale: 'es-ES', timezoneId: 'Europe/Madrid', languages: ['es-ES', 'es'], weight: 7 },
];

const BUILTIN_VIEWPORT_POOL = [
  { width: 1920, height: 1080, weight: 40 },
  { width: 1366, height: 768, weight: 20 },
  { width: 1440, height: 900, weight: 15 },
  { width: 1536, height: 864, weight: 12 },
  { width: 1280, height: 720, weight: 8 },
  { width: 2560, height: 1440, weight: 5 },
];

function hash(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function seededRandom(seed) {
  // Use only the first HASH_PREFIX_LENGTH hex digits (32 bits) of the hash.
  // The LCG modulus is small, so 32 bits of state are plenty; using fewer
  // digits also avoids exceeding Number.MAX_SAFE_INTEGER during parseInt.
  let state = parseInt(hash(seed).slice(0, HASH_PREFIX_LENGTH), 16);
  return function next() {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
}

function getWeight(item) {
  const weight = item.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RangeError(`Invalid weight: ${weight}. Weight must be a non-negative finite number.`);
  }
  return weight;
}

function weightedPick(pool, rand) {
  if (!pool || pool.length === 0) {
    throw new TypeError('Cannot pick from an empty pool.');
  }

  const total = pool.reduce((sum, item) => sum + getWeight(item), 0);
  if (total <= 0) {
    throw new RangeError('Total weight must be greater than zero.');
  }

  let threshold = rand() * total;
  for (const item of pool) {
    const weight = getWeight(item);
    if (threshold < weight) return item;
    threshold -= weight;
  }

  // Floating point arithmetic may leave a tiny residual; fall back to the last
  // item instead of returning undefined. This path is reached only when the
  // random draw lands at the very end of the cumulative distribution due to
  // rounding.
  return pool[pool.length - 1];
}

const uaPoolCache = { key: null, value: null };
const localePoolCache = { key: null, value: null };

function parseUaPool() {
  const path = process.env.CRAWLER_UA_POOL_PATH;
  if (!path) return BUILTIN_UA_POOL;
  if (uaPoolCache.key === path) return uaPoolCache.value;

  const fs = require('fs');
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`UA pool file does not exist: ${path}`);
    }
    throw new Error(`Failed to read UA pool from ${path}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse UA pool JSON from ${path}: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`UA pool from ${path} must be a JSON array, got ${typeof parsed}`);
  }

  const pool = parsed.map((item, index) => {
    if (typeof item === 'string') return { ua: item, weight: 1 };
    if (item && typeof item === 'object') {
      if (typeof item.ua !== 'string' || item.ua.trim().length === 0) {
        throw new Error(`UA pool item at index ${index} is missing a valid "ua" string field`);
      }
      return item;
    }
    throw new Error(`UA pool item at index ${index} must be a string or an object with a "ua" field`);
  });

  uaPoolCache.key = path;
  uaPoolCache.value = pool;
  return pool;
}

function parseLocalePool() {
  const locales = process.env.CRAWLER_LOCALES;
  if (!locales) return BUILTIN_LOCALE_POOL;
  if (localePoolCache.key === locales) return localePoolCache.value;

  const wanted = locales.split(',').map(s => s.trim());
  const filtered = BUILTIN_LOCALE_POOL.filter(item => wanted.includes(item.locale));

  if (filtered.length === 0) {
    console.warn(`[stealth-profile] CRAWLER_LOCALES="${locales}" matched no built-in locales; falling back to built-in pool.`);
    localePoolCache.key = locales;
    localePoolCache.value = BUILTIN_LOCALE_POOL;
    return BUILTIN_LOCALE_POOL;
  }

  localePoolCache.key = locales;
  localePoolCache.value = filtered;
  return filtered;
}

function derivePlatform(userAgent) {
  if (userAgent.includes('Windows')) return 'Win32';
  if (userAgent.includes('Macintosh')) return 'MacIntel';
  if (userAgent.includes('Android')) return 'Linux armv8l';
  if (userAgent.includes('iPad')) return 'iPad';
  if (userAgent.includes('iPhone') || userAgent.includes('iPod')) return 'iPhone';
  if (userAgent.includes('Linux')) return 'Linux x86_64';
  // Conservative fallback: most crawlers target desktop sites, so Win32 is the
  // safest default when the UA does not contain a recognized platform token.
  return 'Win32';
}

function createProfile({
  nodeCode = 'crawler-01',
  channelId = 1,
  sessionIndex = 0,
  mode = 'channel',
  fixedUserAgent = null,
} = {}) {
  if (mode === 'fixed') {
    return buildProfileFromUa(fixedUserAgent || DEFAULT_USER_AGENT, {
      nodeCode, channelId, sessionIndex, mode,
    });
  }

  const seed = `${nodeCode}:${channelId}:${mode === 'session' ? sessionIndex : 0}`;
  const rand = seededRandom(seed);
  const uaPool = parseUaPool();
  const localePool = parseLocalePool();
  const uaItem = weightedPick(uaPool, rand);
  const localeItem = weightedPick(localePool, rand);
  const viewportItem = weightedPick(BUILTIN_VIEWPORT_POOL, rand);
  const deviceMemory = weightedPick(BUILTIN_DEVICE_MEMORY_POOL, rand).v;
  const hardwareConcurrency = weightedPick(BUILTIN_HARDWARE_CONCURRENCY_POOL, rand).v;

  return buildProfile({
    userAgent: uaItem.ua,
    viewport: { width: viewportItem.width, height: viewportItem.height },
    locale: localeItem.locale,
    timezoneId: localeItem.timezoneId,
    languages: localeItem.languages,
    platform: derivePlatform(uaItem.ua),
    deviceMemory,
    hardwareConcurrency,
    colorDepth: 24,
    nodeCode,
    channelId,
    sessionIndex,
    mode,
  });
}

function buildProfileFromUa(userAgent, meta) {
  const localeItem = BUILTIN_LOCALE_POOL[0];
  return buildProfile({
    userAgent,
    viewport: { width: 1920, height: 1080 },
    locale: localeItem.locale,
    timezoneId: localeItem.timezoneId,
    languages: localeItem.languages,
    platform: derivePlatform(userAgent),
    deviceMemory: 8,
    hardwareConcurrency: 8,
    colorDepth: 24,
    ...meta,
  });
}

function buildProfile(fields) {
  const profile = { ...fields };
  profile.signature = hash(JSON.stringify({
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    platform: profile.platform,
    deviceMemory: profile.deviceMemory,
    hardwareConcurrency: profile.hardwareConcurrency,
    nodeCode: profile.nodeCode,
    channelId: profile.channelId,
    sessionIndex: profile.sessionIndex,
    mode: profile.mode,
  })).slice(0, HASH_PREFIX_LENGTH);
  profile.uaHash = hash(profile.userAgent).slice(0, HASH_PREFIX_LENGTH);
  profile.stealthScript = generateStealthScript(profile);
  return profile;
}

function generateStealthScript(profile) {
  const { languages, platform, deviceMemory, hardwareConcurrency, colorDepth, viewport } = profile;
  return `(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)} });
    Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${deviceMemory} });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hardwareConcurrency} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${colorDepth} });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    const viewportWidth = ${viewport.width};
    const viewportHeight = ${viewport.height};
    Object.defineProperty(window, 'outerWidth', { get: () => viewportWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => viewportHeight + 85 });
  })()`;
}

module.exports = {
  hash,
  seededRandom,
  weightedPick,
  createProfile,
  buildProfile,
  generateStealthScript,
};
