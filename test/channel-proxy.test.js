const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Channel } = require('../src/channel');

describe('Channel proxy configuration', () => {
  it('parses proxy URL into server, username and password for Playwright', () => {
    const channel = new Channel({
      id: 1,
      config: {
        proxy: 'http://user-region-EU-session-node-ch1-abc123-sticky-30:pass%23word@proxy.example.com:8080',
      },
      log: () => {},
    });

    const options = channel._buildContextOptions();

    assert.deepStrictEqual(options.proxy, {
      server: 'http://proxy.example.com:8080',
      username: 'user-region-EU-session-node-ch1-abc123-sticky-30',
      password: 'pass#word',
    });
  });

  it('supports proxy URL without credentials', () => {
    const channel = new Channel({
      id: 1,
      config: {
        proxy: 'http://proxy.example.com:8080',
      },
      log: () => {},
    });

    const options = channel._buildContextOptions();

    assert.deepStrictEqual(options.proxy, {
      server: 'http://proxy.example.com:8080',
    });
  });

  it('supports bare host:port proxy URL', () => {
    const channel = new Channel({
      id: 1,
      config: {
        proxy: '1.1.1.1:8080',
      },
      log: () => {},
    });

    const options = channel._buildContextOptions();

    assert.deepStrictEqual(options.proxy, {
      server: 'http://1.1.1.1:8080',
    });
  });

  it('omits proxy when not configured', () => {
    const channel = new Channel({
      id: 1,
      config: {},
      log: () => {},
    });

    const options = channel._buildContextOptions();

    assert.strictEqual(options.proxy, undefined);
  });
});
