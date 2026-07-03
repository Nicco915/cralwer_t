const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const { generate, parseArgs } = require('../../deployment/crawlab/generate-compose');

function runParse(argv) {
  return parseArgs(['node', 'script', ...argv]);
}

describe('generate-compose', () => {
  it('generates 6 nodes by default', () => {
    const content = generate({ nodes: 6 });
    assert.ok(content.includes('crawler-1:'));
    assert.ok(content.includes('crawler-6:'));
    assert.ok(!content.includes('crawler-7:'));
  });

  it('assigns unique nodeCode per node', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-01'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-02'));
    assert.ok(content.includes('CRAWLER_NODE_CODE=crawler-03'));
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
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-01'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-02'));
    assert.ok(content.includes('CRAWLER_CLIPROXY_SESSION_PREFIX=crawler-03'));
  });

  it('binds each health port to 127.0.0.1', () => {
    const content = generate({ nodes: 3 });
    assert.ok(content.includes('"127.0.0.1:3001:3001"'));
    assert.ok(content.includes('"127.0.0.1:3002:3002"'));
    assert.ok(content.includes('"127.0.0.1:3003:3003"'));
  });

  it('uses per-node output and image directories', () => {
    const content = generate({ nodes: 2 });
    assert.ok(content.includes('./output/crawler-01:/app/output'));
    assert.ok(content.includes('./output/crawler-02:/app/output'));
    assert.ok(content.includes('./images/crawler-01:/app/images'));
    assert.ok(content.includes('./images/crawler-02:/app/images'));
  });

  it('adds resource limits to each node', () => {
    const content = generate({ nodes: 1 });
    assert.ok(content.includes("cpus: '0.5'"));
    assert.ok(content.includes('memory: 800M'));
  });

  it('adds resource reservations to each node', () => {
    const content = generate({ nodes: 1 });
    assert.ok(content.includes("cpus: '0.2'"));
    assert.ok(content.includes('memory: 400M'));
  });

  it('parses --output with equals sign', () => {
    const result = runParse(['--output=custom.yml']);
    assert.ok(result.output.endsWith('custom.yml'));
  });

  it('parses --output as separate argument', () => {
    const result = runParse(['--output', 'custom.yml']);
    assert.ok(result.output.endsWith('custom.yml'));
  });

  it('rejects decimal node counts', () => {
    assert.throws(() => runParse(['--nodes=2.5']), /错误/);
  });

  it('rejects unknown arguments', () => {
    assert.throws(() => runParse(['--nods=5']), /未识别|错误/);
  });

  it('rejects invalid node counts', () => {
    assert.throws(() => runParse(['--nodes=0']), /错误/);
    assert.throws(() => runParse(['--nodes=abc']), /错误/);
    assert.throws(() => runParse(['--nodes=21']), /错误/);
  });

  it('generates valid YAML that can be parsed by Python yaml', () => {
    const content = generate({ nodes: 1 });
    execSync('python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)"', {
      input: content,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
});
