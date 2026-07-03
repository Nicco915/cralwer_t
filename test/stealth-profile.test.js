const { describe, it } = require('node:test');
const assert = require('node:assert');
const { hash, seededRandom, weightedPick } = require('../src/stealth-profile');

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
