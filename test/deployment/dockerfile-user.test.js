const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Dockerfile security', () => {
  const dockerfile = fs.readFileSync(path.resolve('deployment/docker/Dockerfile'), 'utf-8');

  it('creates and uses crawler non-root user', () => {
    assert.ok(/groupadd\s+-r\s+crawler/.test(dockerfile), 'should create crawler group');
    assert.ok(/useradd\s+-r\s+-g\s+crawler/.test(dockerfile), 'should create crawler user');
    assert.ok(/USER\s+crawler/.test(dockerfile), 'should switch to crawler user');
  });

  it('uses chown for copied files', () => {
    assert.ok(/COPY\s+--chown=crawler:crawler/.test(dockerfile), 'COPY should use --chown=crawler:crawler');
  });

  it('does not hardcode --mode=service in CMD', () => {
    assert.ok(!/CMD\s*\[.*--mode=service/.test(dockerfile), 'CMD should not hardcode --mode=service');
  });

  it('sets PLAYWRIGHT_BROWSERS_PATH for non-root user', () => {
    assert.ok(/PLAYWRIGHT_BROWSERS_PATH=\/app\/ms-playwright/.test(dockerfile), 'should set Playwright browsers path');
  });
});
