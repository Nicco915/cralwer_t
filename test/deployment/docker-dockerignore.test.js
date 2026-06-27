const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('.dockerignore', () => {
  let dockerignorePath;

  before(() => {
    dockerignorePath = path.resolve(__dirname, '../../deployment/docker/.dockerignore');
  });

  it('excludes .env and node_modules', () => {
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore should exist');
    const content = fs.readFileSync(dockerignorePath, 'utf-8');
    assert.ok(content.includes('.env'), 'should ignore .env');
    assert.ok(content.includes('node_modules'), 'should ignore node_modules');
  });
});
