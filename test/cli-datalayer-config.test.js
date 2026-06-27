const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

describe('dataLayer CLI configuration', () => {
  it('parses --data-layer-max-retries', () => {
    const config = parse(['--data-layer-max-retries', '5']);
    assert.strictEqual(config.dataLayerMaxRetries, 5);
  });

  it('parses --data-layer-failure-threshold', () => {
    const config = parse(['--data-layer-failure-threshold', '10']);
    assert.strictEqual(config.dataLayerFailureThreshold, 10);
  });

  it('falls back to CRAWLER_DATA_LAYER_MAX_RETRIES environment variable', () => {
    process.env.CRAWLER_DATA_LAYER_MAX_RETRIES = '7';
    try {
      const config = parse([]);
      assert.strictEqual(config.dataLayerMaxRetries, 7);
    } finally {
      delete process.env.CRAWLER_DATA_LAYER_MAX_RETRIES;
    }
  });

  it('falls back to CRAWLER_DATA_LAYER_FAILURE_THRESHOLD environment variable', () => {
    process.env.CRAWLER_DATA_LAYER_FAILURE_THRESHOLD = '15';
    try {
      const config = parse([]);
      assert.strictEqual(config.dataLayerFailureThreshold, 15);
    } finally {
      delete process.env.CRAWLER_DATA_LAYER_FAILURE_THRESHOLD;
    }
  });
});
