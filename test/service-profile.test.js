const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { CrawlerService } = require('../src/service');

describe('Service profile distribution', () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('passes nodeCode and stealthMode to channels', () => {
    const service = new CrawlerService({
      nodeCode: 'node-a',
      stealthMode: 'channel',
      channels: 2,
      imageDir: '/tmp/images',
    });
    assert.strictEqual(service.config.nodeCode, 'node-a');
    assert.strictEqual(service.config.stealthMode, 'channel');
  });

  it('prefers explicit non-nullish nodeCode/stealthMode over env vars', () => {
    const originalNodeCode = process.env.CRAWLER_NODE_CODE;
    const originalStealthMode = process.env.CRAWLER_STEALTH_MODE;
    process.env.CRAWLER_NODE_CODE = 'env-node';
    process.env.CRAWLER_STEALTH_MODE = 'env-mode';

    try {
      const service = new CrawlerService({
        nodeCode: 'explicit-node',
        stealthMode: 'explicit-mode',
        channels: 2,
        imageDir: '/tmp/images',
      });
      assert.strictEqual(service.config.nodeCode, 'explicit-node');
      assert.strictEqual(service.config.stealthMode, 'explicit-mode');
    } finally {
      process.env.CRAWLER_NODE_CODE = originalNodeCode;
      process.env.CRAWLER_STEALTH_MODE = originalStealthMode;
    }
  });

  it('falls back to env vars when nodeCode/stealthMode are nullish', () => {
    const originalNodeCode = process.env.CRAWLER_NODE_CODE;
    const originalStealthMode = process.env.CRAWLER_STEALTH_MODE;
    process.env.CRAWLER_NODE_CODE = 'env-node';
    process.env.CRAWLER_STEALTH_MODE = 'env-mode';

    try {
      const service = new CrawlerService({
        nodeCode: null,
        stealthMode: undefined,
        channels: 2,
        imageDir: '/tmp/images',
      });
      assert.strictEqual(service.config.nodeCode, 'env-node');
      assert.strictEqual(service.config.stealthMode, 'env-mode');
    } finally {
      process.env.CRAWLER_NODE_CODE = originalNodeCode;
      process.env.CRAWLER_STEALTH_MODE = originalStealthMode;
    }
  });

  it('falls back to defaults when nodeCode/stealthMode are nullish and env vars are unset', () => {
    const originalNodeCode = process.env.CRAWLER_NODE_CODE;
    const originalStealthMode = process.env.CRAWLER_STEALTH_MODE;
    delete process.env.CRAWLER_NODE_CODE;
    delete process.env.CRAWLER_STEALTH_MODE;

    try {
      const service = new CrawlerService({
        nodeCode: undefined,
        stealthMode: null,
        channels: 2,
        imageDir: '/tmp/images',
      });
      assert.strictEqual(service.config.nodeCode, 'crawler-01');
      assert.strictEqual(service.config.stealthMode, 'channel');
    } finally {
      process.env.CRAWLER_NODE_CODE = originalNodeCode;
      process.env.CRAWLER_STEALTH_MODE = originalStealthMode;
    }
  });

  it('initializes channels with nodeCode, stealthMode and profile', async () => {
    const logs = [];
    const service = new CrawlerService({
      nodeCode: 'node-a',
      stealthMode: 'channel',
      channels: 2,
      imageDir: path.join(os.tmpdir(), 'images-service-test'),
    });
    service.log = (...args) => logs.push(args.join(' '));
    service.worker = { addChannel: () => {} };
    service.browser = browser;

    await service.initChannels();
    try {
      assert.strictEqual(service.channels.length, 2);

      for (const channel of service.channels) {
        assert.strictEqual(channel.nodeCode, 'node-a');
        assert.strictEqual(channel.stealthMode, 'channel');
        assert.ok(channel.profile);
        assert.match(channel.profile.signature, /^[a-f0-9]{8}$/);
        assert.match(channel.profile.uaHash, /^[a-f0-9]{8}$/);
      }

      const initLogs = logs.filter((msg) =>
        typeof msg === 'string' && msg.includes('Channel') && msg.includes('profile=')
      );
      assert.strictEqual(initLogs.length, 2);
      for (const msg of initLogs) {
        assert.match(msg, /profile=[a-f0-9]{8}/);
        assert.match(msg, /uaHash=[a-f0-9]{8}/);
      }
    } finally {
      for (const channel of service.channels) {
        await channel.close();
      }
    }
  });
});
