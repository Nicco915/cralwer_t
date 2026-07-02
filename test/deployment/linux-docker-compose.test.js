const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment/linux/docker-compose.yml', () => {
  let composePath;

  before(() => {
    composePath = path.resolve(__dirname, '../../deployment/linux/docker-compose.yml');
  });

  it('exists and disables headed fallback explicitly', () => {
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml should exist');
    const content = fs.readFileSync(composePath, 'utf-8');
    assert.ok(content.includes('CRAWLER_HEADED_FALLBACK=false'), 'should explicitly disable headed fallback');
    assert.ok(content.includes('CRAWLER_MODE=service'), 'should set service mode');
    assert.ok(content.includes('${CRAWLER_IMAGE:?'), 'should require CRAWLER_IMAGE');
  });
});
