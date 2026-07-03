const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hash, seededRandom, weightedPick, createProfile, buildProfile, generateStealthScript } = require('../src/stealth-profile');

describe('hash', () => {
  it('returns sha256 hex of input', () => {
    const result = hash('hello');
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('seededRandom', () => {
  it('is deterministic for the same seed', () => {
    const a = seededRandom('node-a:1:0');
    const b = seededRandom('node-a:1:0');
    assert.strictEqual(a(), b());
    assert.strictEqual(a(), b());
  });

  it('produces identical long sequences for identical seeds', () => {
    const a = seededRandom('long-seed-test');
    const b = seededRandom('long-seed-test');
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(a(), b());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = seededRandom('node-a:1:0');
    const b = seededRandom('node-a:2:0');
    assert.notStrictEqual(a(), b());
  });

  it('returns values in [0, 1)', () => {
    const rand = seededRandom('bounds-check');
    for (let i = 0; i < 100; i++) {
      const v = rand();
      assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
    }
  });
});

describe('weightedPick', () => {
  it('returns the only item when pool has one element', () => {
    const pool = [{ value: 'x', weight: 1 }];
    assert.strictEqual(weightedPick(pool, seededRandom('s')).value, 'x');
  });

  it('throws TypeError when pool is empty', () => {
    assert.throws(() => weightedPick([], () => 0.5), TypeError);
  });

  it('does not select items with weight 0', () => {
    const pool = [
      { value: 'zero', weight: 0 },
      { value: 'one', weight: 1 },
    ];
    const rand = () => 0.1;
    assert.strictEqual(weightedPick(pool, rand).value, 'one');
  });

  it('throws RangeError for negative weight', () => {
    const pool = [{ value: 'x', weight: -1 }];
    assert.throws(() => weightedPick(pool, () => 0.5), RangeError);
  });

  it('throws RangeError for non-numeric weight', () => {
    const pool = [{ value: 'x', weight: 'heavy' }];
    assert.throws(() => weightedPick(pool, () => 0.5), RangeError);
  });

  it('throws RangeError when total weight is zero', () => {
    const pool = [
      { value: 'x', weight: 0 },
      { value: 'y', weight: 0 },
    ];
    assert.throws(() => weightedPick(pool, () => 0.5), RangeError);
  });

  it('selects items proportionally to weights', () => {
    const pool = [
      { value: 'a', weight: 3 },
      { value: 'b', weight: 1 },
    ];
    const rand = seededRandom('distribution-test');
    const counts = { a: 0, b: 0 };
    const n = 4000;
    for (let i = 0; i < n; i++) {
      counts[weightedPick(pool, rand).value]++;
    }
    const ratio = counts.a / counts.b;
    assert.ok(ratio > 2.5 && ratio < 3.5, `expected ratio ~3, got ${ratio} (counts: ${JSON.stringify(counts)})`);
  });
});

describe('createProfile', () => {
  it('returns a profile with required fields', () => {
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.ok(profile.userAgent);
    assert.ok(profile.viewport);
    assert.ok(profile.locale);
    assert.ok(profile.timezoneId);
    assert.ok(profile.platform);
    assert.ok(profile.languages);
    assert.strictEqual(profile.mode, 'channel');
  });

  it('is deterministic for the same node/channel', () => {
    const a = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const b = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.strictEqual(a.userAgent, b.userAgent);
    assert.strictEqual(a.locale, b.locale);
  });

  it('differs across channels', () => {
    const a = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const b = createProfile({ nodeCode: 'node-a', channelId: 2 });
    assert.notStrictEqual(a.signature, b.signature);
    assert.notStrictEqual(a.userAgent + a.signature, b.userAgent + b.signature);
  });

  it('fixed mode returns the configured UA', () => {
    const profile = createProfile({ mode: 'fixed', fixedUserAgent: 'Custom/1.0' });
    assert.strictEqual(profile.userAgent, 'Custom/1.0');
  });

  it('fixed mode without fixedUserAgent falls back to default', () => {
    const profile = createProfile({ mode: 'fixed' });
    assert.ok(profile.userAgent.includes('Chrome/120'));
  });
});

describe('parseUaPool via createProfile', () => {
  const originalEnv = process.env.CRAWLER_UA_POOL_PATH;
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-pool-'));
  });

  after(() => {
    if (originalEnv === undefined) delete process.env.CRAWLER_UA_POOL_PATH;
    else process.env.CRAWLER_UA_POOL_PATH = originalEnv;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws clear Error when UA pool file does not exist', () => {
    process.env.CRAWLER_UA_POOL_PATH = path.join(tempDir, 'missing.json');
    assert.throws(
      () => createProfile({ nodeCode: 'node-a', channelId: 1 }),
      (err) => err instanceof Error && /UA pool/i.test(err.message) && /exist/i.test(err.message)
    );
  });

  it('throws clear Error when UA pool file contains invalid JSON', () => {
    const badPath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(badPath, 'not json');
    process.env.CRAWLER_UA_POOL_PATH = badPath;
    assert.throws(
      () => createProfile({ nodeCode: 'node-a', channelId: 1 }),
      (err) => err instanceof Error && /UA pool/i.test(err.message) && /JSON/i.test(err.message)
    );
  });

  it('throws clear Error when UA pool file does not contain an array', () => {
    const badPath = path.join(tempDir, 'object.json');
    fs.writeFileSync(badPath, JSON.stringify({ ua: 'x' }));
    process.env.CRAWLER_UA_POOL_PATH = badPath;
    assert.throws(
      () => createProfile({ nodeCode: 'node-a', channelId: 1 }),
      (err) => err instanceof Error && /UA pool/i.test(err.message) && /array/i.test(err.message)
    );
  });

  it('throws clear Error when UA pool item object lacks ua', () => {
    const badPath = path.join(tempDir, 'no-ua.json');
    fs.writeFileSync(badPath, JSON.stringify([{ weight: 1 }]));
    process.env.CRAWLER_UA_POOL_PATH = badPath;
    assert.throws(
      () => createProfile({ nodeCode: 'node-a', channelId: 1 }),
      (err) => err instanceof Error && /ua/i.test(err.message)
    );
  });

  it('converts string items to objects with weight 1', () => {
    const ua = 'Mozilla/5.0 (Custom/1.0)';
    const goodPath = path.join(tempDir, 'strings.json');
    fs.writeFileSync(goodPath, JSON.stringify([ua]));
    process.env.CRAWLER_UA_POOL_PATH = goodPath;
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.strictEqual(profile.userAgent, ua);
  });
});

describe('parseLocalePool via createProfile', () => {
  const originalEnv = process.env.CRAWLER_LOCALES;
  const warnings = [];
  const originalWarn = console.warn;

  before(() => {
    console.warn = (...args) => warnings.push(args.join(' '));
  });

  after(() => {
    if (originalEnv === undefined) delete process.env.CRAWLER_LOCALES;
    else process.env.CRAWLER_LOCALES = originalEnv;
    console.warn = originalWarn;
  });

  beforeEach(() => {
    warnings.length = 0;
    delete process.env.CRAWLER_LOCALES;
  });

  it('falls back to builtin locale pool when CRAWLER_LOCALES filters to empty', () => {
    process.env.CRAWLER_LOCALES = 'xx-XX,yy-YY';
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    assert.ok(['en-GB', 'en-US', 'de-DE', 'fr-FR', 'nl-NL', 'es-ES'].includes(profile.locale));
    assert.ok(warnings.some(w => /locale/i.test(w)));
  });
});

describe('derivePlatform via createProfile', () => {
  it('identifies Android UA as Linux armv8l', () => {
    const profile = createProfile({
      mode: 'fixed',
      fixedUserAgent: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36',
    });
    assert.strictEqual(profile.platform, 'Linux armv8l');
  });

  it('identifies iPhone UA as iPhone', () => {
    const profile = createProfile({
      mode: 'fixed',
      fixedUserAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    assert.strictEqual(profile.platform, 'iPhone');
  });

  it('identifies iPad UA as iPad', () => {
    const profile = createProfile({
      mode: 'fixed',
      fixedUserAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    assert.strictEqual(profile.platform, 'iPad');
  });

  it('falls back to Win32 for unknown UA', () => {
    const profile = createProfile({ mode: 'fixed', fixedUserAgent: 'Bot/1.0' });
    assert.strictEqual(profile.platform, 'Win32');
  });
});

describe('buildProfile signature', () => {
  it('includes nodeCode, channelId, sessionIndex, and mode in signature', () => {
    const base = {
      userAgent: 'UA/1.0',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      languages: ['en-GB', 'en'],
      platform: 'Win32',
      deviceMemory: 8,
      hardwareConcurrency: 8,
      colorDepth: 24,
      sessionIndex: 0,
      mode: 'channel',
    };
    const a = buildProfile({ ...base, nodeCode: 'node-a', channelId: 1 });
    const b = buildProfile({ ...base, nodeCode: 'node-a', channelId: 2 });
    const c = buildProfile({ ...base, nodeCode: 'node-b', channelId: 1 });
    const d = buildProfile({ ...base, nodeCode: 'node-a', channelId: 1, sessionIndex: 1 });
    const e = buildProfile({ ...base, nodeCode: 'node-a', channelId: 1, mode: 'session' });
    assert.notStrictEqual(a.signature, b.signature);
    assert.notStrictEqual(a.signature, c.signature);
    assert.notStrictEqual(a.signature, d.signature);
    assert.notStrictEqual(a.signature, e.signature);
  });
});

describe('createProfile session mode', () => {
  it('returns different UA for different sessionIndex', () => {
    let idxA = null;
    let idxB = null;
    for (let i = 1; i < 200; i++) {
      const r = seededRandom(`node-a:1:${i}`)();
      if (r < 0.5 && idxA === null) idxA = i;
      if (r >= 0.5 && idxB === null) idxB = i;
      if (idxA !== null && idxB !== null) break;
    }
    assert.ok(idxA !== null && idxB !== null, 'could not find session indices on opposite sides of 0.5');
    const a = createProfile({ nodeCode: 'node-a', channelId: 1, mode: 'session', sessionIndex: idxA });
    const b = createProfile({ nodeCode: 'node-a', channelId: 1, mode: 'session', sessionIndex: idxB });
    assert.notStrictEqual(a.userAgent, b.userAgent);
  });

  it('returns same UA for same sessionIndex', () => {
    const a = createProfile({ nodeCode: 'node-a', channelId: 1, mode: 'session', sessionIndex: 5 });
    const b = createProfile({ nodeCode: 'node-a', channelId: 1, mode: 'session', sessionIndex: 5 });
    assert.strictEqual(a.userAgent, b.userAgent);
  });
});

describe('pool caching', () => {
  const originalUaEnv = process.env.CRAWLER_UA_POOL_PATH;
  const originalLocaleEnv = process.env.CRAWLER_LOCALES;
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cache-'));
  });

  after(() => {
    if (originalUaEnv === undefined) delete process.env.CRAWLER_UA_POOL_PATH;
    else process.env.CRAWLER_UA_POOL_PATH = originalUaEnv;
    if (originalLocaleEnv === undefined) delete process.env.CRAWLER_LOCALES;
    else process.env.CRAWLER_LOCALES = originalLocaleEnv;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.CRAWLER_UA_POOL_PATH;
    delete process.env.CRAWLER_LOCALES;
  });

  it('caches UA pool based on CRAWLER_UA_POOL_PATH', () => {
    const ua = 'Mozilla/5.0 (Cached/1.0)';
    const poolPath = path.join(tempDir, 'cached.json');
    fs.writeFileSync(poolPath, JSON.stringify([ua]));
    process.env.CRAWLER_UA_POOL_PATH = poolPath;

    const first = createProfile({ nodeCode: 'cache-a', channelId: 1 });
    assert.strictEqual(first.userAgent, ua);

    fs.unlinkSync(poolPath);
    const second = createProfile({ nodeCode: 'cache-a', channelId: 1 });
    assert.strictEqual(second.userAgent, ua);
  });

  it('caches locale pool based on CRAWLER_LOCALES', () => {
    process.env.CRAWLER_LOCALES = 'en-US';
    const first = createProfile({ nodeCode: 'cache-b', channelId: 1 });
    assert.strictEqual(first.locale, 'en-US');

    process.env.CRAWLER_LOCALES = 'de-DE';
    const second = createProfile({ nodeCode: 'cache-b', channelId: 1 });
    assert.strictEqual(second.locale, 'de-DE');

    process.env.CRAWLER_LOCALES = 'en-US';
    const third = createProfile({ nodeCode: 'cache-b', channelId: 1 });
    assert.strictEqual(third.locale, 'en-US');
  });
});

describe('generateStealthScript', () => {
  it('returns a function string containing expected patches', () => {
    const profile = createProfile({ nodeCode: 'node-a', channelId: 1 });
    const script = generateStealthScript(profile);
    assert.ok(script.includes("Object.defineProperty(navigator, 'webdriver'"));
    assert.ok(script.includes("Object.defineProperty(navigator, 'languages'"));
    assert.ok(script.includes("Object.defineProperty(navigator, 'platform'"));
    assert.ok(script.includes('window.chrome = { runtime: {} }'));
  });
});
