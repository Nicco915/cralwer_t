const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generate, parseArgs } = require('../../deployment/crawlab/generate-compose');

describe('generate-compose', () => {
  it('generates 6 nodes by default', () => {
    const content = generate({ nodes: 6 });
    assert.ok(content.includes('crawler-1:'));
    assert.ok(content.includes('crawler-6:'));
    assert.ok(!content.includes('crawler-7:'));
  });

  it('assigns unique nodeCode per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-01'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-02'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-eu-03'));
    const matches = content.match(/CRAWLER_NODE_CODE=/g);
    assert.strictEqual(matches.length, 3);
  });

  it('assigns unique healthPort per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3001'));
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3002'));
    assert.ok(content.includes('CRAWLER_HEALTH_PORT=3003'));
  });

  it('assigns unique sessionPrefix per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-01'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-02'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-eu-03'));
  });

  it('binds each health port to 127.0.0.1', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('"127.0.0.1:3001:3001"'));
    assert.ok(content.includes('"127.0.0.1:3002:3002"'));
    assert.ok(content.includes('"127.0.0.1:3003:3003"'));
  });

  it('uses per-node output and image directories', () => {
    const content = generate({ nodes: 2 });
    assert.ok(content.includes('./output/crawler-eu-01:/app/output'));
    assert.ok(content.includes('./output/crawler-eu-02:/app/output'));
    assert.ok(content.includes('./images/crawler-eu-01:/app/images'));
    assert.ok(content.includes('./images/crawler-eu-02:/app/images'));
  });

  it('adds resource limits to each node', () => {
    const content = generate({ nodes: 1 });
    assert.ok(content.includes("cpus: '0.5'"));
    assert.ok(content.includes('memory: 800M'));
  });

  it('rejects invalid node counts', () => {
    assert.throws(() => parseArgs(['node', 'script', '--nodes=0']), /错误/);
    assert.throws(() => parseArgs(['node', 'script', '--nodes=abc']), /错误/);
    assert.throws(() => parseArgs(['node', 'script', '--nodes=21']), /错误/);
  });
});
