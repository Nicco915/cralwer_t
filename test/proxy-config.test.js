const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');
const { Channel } = require('../src/channel');

describe('Proxy configuration', () => {
  it('parses --proxy flag via CLI', () => {
    const config = parse(['--proxy', 'http://proxy:8080']);
    assert.strictEqual(config.proxy, 'http://proxy:8080');
  });

  it('falls back to CRAWLER_PROXY environment variable', () => {
    process.env.CRAWLER_PROXY = 'http://env-proxy:8080';
    try {
      const config = parse([]);
      assert.strictEqual(config.proxy, 'http://env-proxy:8080');
    } finally {
      delete process.env.CRAWLER_PROXY;
    }
  });

  it('passes proxy to browser context when configured', async () => {
    let contextOptions;
    const fakeBrowser = {
      newContext: async (options) => {
        contextOptions = options;
        return {
          addInitScript: async () => {},
          newPage: async () => ({}),
        };
      },
    };

    const channel = new Channel({
      id: 1,
      config: { proxy: 'http://proxy:8080' },
      log: () => {},
    });

    await channel.init(fakeBrowser);

    assert.ok(contextOptions);
    assert.strictEqual(contextOptions.proxy.server, 'http://proxy:8080');
  });
});
