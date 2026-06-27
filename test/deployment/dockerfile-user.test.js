const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Dockerfile security', () => {
  const dockerfile = fs.readFileSync(path.resolve('deployment/docker/Dockerfile'), 'utf-8');

  it('uses a non-root user', () => {
    assert.ok(/USER\s+\S+/.test(dockerfile), 'Dockerfile should set a non-root USER');
    assert.ok(/groupadd/.test(dockerfile) || /useradd/.test(dockerfile), 'Dockerfile should create a non-root user');
  });

  it('does not hardcode --mode=service in CMD', () => {
    assert.ok(!/CMD\s*\[.*--mode=service/.test(dockerfile), 'CMD should not hardcode --mode=service');
  });
});
