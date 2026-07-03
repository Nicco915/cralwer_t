const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { Channel } = require('../src/channel');

describe('Channel profile integration', () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('uses profile userAgent in channel mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'channel' },
      log: () => {},
    });
    await channel.init(browser);
    assert.ok(channel.browserContext._options.userAgent);
    await channel.browserContext.close();
  });

  it('uses fixed userAgent in fixed mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'fixed', userAgent: 'Custom/1.0' },
      log: () => {},
    });
    await channel.init(browser);
    assert.strictEqual(channel.browserContext._options.userAgent, 'Custom/1.0');
    await channel.browserContext.close();
  });

  it('recreateContext changes UA in session mode', async () => {
    const channel = new Channel({
      id: 1,
      config: { nodeCode: 'node-a', stealthMode: 'session' },
      log: () => {},
    });
    await channel.init(browser);
    const firstUa = channel.browserContext._options.userAgent;
    await channel.recreateContext(browser);
    const secondUa = channel.browserContext._options.userAgent;
    assert.notStrictEqual(firstUa, secondUa);
    await channel.browserContext.close();
  });
});
