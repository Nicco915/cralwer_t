const { describe, it } = require('node:test');
const assert = require('node:assert');
const { CrawlerService } = require('../src/service');

describe('Service profile distribution', () => {
  it('passes nodeCode and stealthMode to channels', () => {
    const logs = [];
    const service = new CrawlerService({
      nodeCode: 'node-a',
      stealthMode: 'channel',
      channels: 2,
      imageDir: '/tmp/images',
    });
    service.log = (msg) => logs.push(msg);
    assert.strictEqual(service.config.nodeCode, 'node-a');
    assert.strictEqual(service.config.stealthMode, 'channel');
  });
});
