const crypto = require('crypto');

// LCG parameters from the Numerical Recipes "quick and dirty" generator.
// The modulus 233280 gives a full period for these multipliers, which is
// more than enough for header randomization where we only need a few draws.
const LCG_MULTIPLIER = 9301;
const LCG_INCREMENT = 49297;
const LCG_MODULUS = 233280;

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

module.exports = { hash, seededRandom, weightedPick };
