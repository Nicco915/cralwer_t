const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');
const { buildServiceConfig } = require('../bin/run');

describe('buildServiceConfig reads CRAWLER_HEALTH_PORT', () => {
  let originalHealthPort;

  beforeEach(() => {
    originalHealthPort = process.env.CRAWLER_HEALTH_PORT;
    delete process.env.CRAWLER_HEALTH_PORT;
  });

  afterEach(() => {
    if (originalHealthPort !== undefined) {
      process.env.CRAWLER_HEALTH_PORT = originalHealthPort;
    } else {
      delete process.env.CRAWLER_HEALTH_PORT;
    }
  });

  it('maps CRAWLER_HEALTH_PORT to healthPort as number', () => {
    process.env.CRAWLER_HEALTH_PORT = '3001';
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, 3001);
  });

  it('defaults healthPort to undefined when not set', () => {
    delete process.env.CRAWLER_HEALTH_PORT;
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, undefined);
  });

  it('treats non-numeric CRAWLER_HEALTH_PORT as undefined', () => {
    process.env.CRAWLER_HEALTH_PORT = 'abc';
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, undefined);
  });

  it('treats empty CRAWLER_HEALTH_PORT as undefined', () => {
    process.env.CRAWLER_HEALTH_PORT = '';
    const config = parse([]);
    const serviceConfig = buildServiceConfig(config);
    assert.strictEqual(serviceConfig.healthPort, undefined);
  });
});
