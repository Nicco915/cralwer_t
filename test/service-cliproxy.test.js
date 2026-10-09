const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('CrawlerService Cliproxy integration', { timeout: 60000 }, () => {
  it('creates CliproxyPool when Cliproxy credentials are configured', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-images',
      cliproxyHost: 'test.cliproxy.io',
      cliproxyPort: 1080,
      cliproxyUsername: 'user',
      cliproxyPassword: 'pass',
      cliproxyRegion: 'EU',
      cliproxyStickyMinutes: 30,
      cliproxySessionPrefix: 'test',
    });

    service.ensureImageDir();
    await service.startProxyPool();

    assert.ok(service.proxyPool, 'proxyPool should be created');
    assert.ok(service.proxyPool.getProxyForChannel('ch-1'));
    assert.ok(service.proxyPool.getProxyForChannel('ch-1').includes('test.cliproxy.io'));

    try { await service.stop(); } catch (e) {}
  });

  it('does not create proxy pool when only static proxy is set', async () => {
    const service = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 1,
      imageDir: '/tmp/test-images-2',
      proxy: 'http://static-proxy:8080',
    });

    service.ensureImageDir();
    await service.startProxyPool();

    assert.strictEqual(service.proxyPool, null);

    try { await service.stop(); } catch (e) {}
  });
});
