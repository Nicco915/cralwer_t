const crypto = require('crypto');

// LCG parameters from the Numerical Recipes "quick and dirty" generator.
// The modulus 233280 gives a full period for these multipliers, which is
// more than enough for header randomization where we only need a few draws.
const LCG_MULTIPLIER = 9301;
const LCG_INCREMENT = 49297;
const LCG_MODULUS = 233280;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

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
  // Use only the first 8 hex digits (32 bits) of the hash. The LCG modulus
  // is small, so 32 bits of state are plenty; using fewer digits also avoids
  // exceeding Number.MAX_SAFE_INTEGER during parseInt.
  let state = parseInt(hash(seed).slice(0, 8), 16);
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

function parseUaPool() {
  const path = process.env.CRAWLER_UA_POOL_PATH;
  if (!path) return BUILTIN_UA_POOL;
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  return raw.map(item => typeof item === 'string' ? { ua: item, weight: 1 } : item);
}

function parseLocalePool() {
  const locales = process.env.CRAWLER_LOCALES;
  if (!locales) return BUILTIN_LOCALE_POOL;
  const wanted = locales.split(',').map(s => s.trim());
  return BUILTIN_LOCALE_POOL.filter(item => wanted.includes(item.locale));
}

function derivePlatform(userAgent) {
  if (userAgent.includes('Windows')) return 'Win32';
  if (userAgent.includes('Macintosh')) return 'MacIntel';
  if (userAgent.includes('Linux')) return 'Linux x86_64';
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
  const deviceMemory = weightedPick([{ v: 4, weight: 15 }, { v: 8, weight: 50 }, { v: 16, weight: 35 }], rand).v;
  const hardwareConcurrency = weightedPick([{ v: 4, weight: 15 }, { v: 8, weight: 55 }, { v: 12, weight: 20 }, { v: 16, weight: 10 }], rand).v;

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
  profile.stealthScript = generateStealthScript(profile);
  profile.signature = hash(JSON.stringify({
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    platform: profile.platform,
    deviceMemory: profile.deviceMemory,
    hardwareConcurrency: profile.hardwareConcurrency,
  })).slice(0, 8);
  profile.uaHash = hash(profile.userAgent).slice(0, 8);
  return profile;
}

function generateStealthScript(profile) {
  // placeholder, implemented in task 3
  return `() => {}`;
}

module.exports = {
  hash,
  seededRandom,
  weightedPick,
  createProfile,
  buildProfile,
  generateStealthScript,
};
