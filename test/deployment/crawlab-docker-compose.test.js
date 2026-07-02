const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment/crawlab/docker-compose.yml', () => {
  let composePath;
  let content;

  before(() => {
    composePath = path.resolve(__dirname, '../../deployment/crawlab/docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml should exist');
    content = fs.readFileSync(composePath, 'utf-8');
  });

  it('defines crawlab, mongo, redis and crawler services', () => {
    assert.ok(content.includes('crawlab:'), 'should define crawlab service');
    assert.ok(content.includes('mongo:'), 'should define mongo service');
    assert.ok(content.includes('redis:'), 'should define redis service');
    assert.ok(content.includes('crawler:'), 'should define crawler service');
  });

  it('exposes crawlab on port 8080', () => {
    assert.ok(content.includes('"8080:8080"'), 'should expose crawlab 8080');
  });

  it('binds crawler health port to 127.0.0.1', () => {
    assert.ok(content.includes('127.0.0.1:3000:3000'), 'should bind health port to localhost only');
  });

  it('sets CRAWLER_HEALTH_PORT=3000', () => {
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3000'), 'should enable health server');
  });

  it('shares logs volume with crawlab read-only', () => {
    assert.ok(content.includes('./logs:/app/logs:ro'), 'crawlab should read logs');
  });

  it('uses a shared crawler-net network', () => {
    assert.ok(content.includes('crawler-net:'), 'should define crawler-net');
  });
});
