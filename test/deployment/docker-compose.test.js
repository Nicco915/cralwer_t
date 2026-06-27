const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('docker-compose.yml', () => {
  let composePath;

  before(() => {
    composePath = path.resolve(__dirname, '../../deployment/docker/docker-compose.yml');
  });

  it('mounts .env as read-only volume and sets restart policy', () => {
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml should exist');
    const content = fs.readFileSync(composePath, 'utf-8');
    assert.ok(content.includes('./.env:/app/.env:ro'), 'should mount .env read-only');
    assert.ok(content.includes('restart: unless-stopped'), 'should set restart policy');
    assert.ok(content.includes('${CRAWLER_IMAGE:?'), 'should use CRAWLER_IMAGE with required error message');
  });
});
