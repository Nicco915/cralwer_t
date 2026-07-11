const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CrawlerService } = require('../src/service');

const TMP_DIR = path.resolve(__dirname, '.tmp/logger');

describe('CrawlerService logger integration', { timeout: 30000 }, () => {
  before(() => fs.mkdirSync(TMP_DIR, { recursive: true }));
  after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

  it('writes JSON lines to logs/crawler.jsonl on every log() call', async () => {
    const svc = new CrawlerService({
      nodeCode: 'test-node',
      nodeToken: '',
      taskUrl: 'http://127.0.0.1:1/tasks',
      callbackUrl: 'http://127.0.0.1:1/callback',
      channels: 0,
      imageDir: '/tmp/test-health-images',
    });
    // 本用例只验证 svc.log() 写 crawler.jsonl，不需要真浏览器；
    // 桩掉 initBrowser 避免拉起 Playwright chromium，让单测快速且与环境无关。
    svc.initBrowser = async () => {
      svc.browser = { isConnected: () => true, close: async () => {} };
    };
    svc.ensureImageDir();
    try {
      await svc.start({ customLogDir: TMP_DIR });
      svc.log('[TEST] hello world', 42);
    } finally {
      await svc.stop();
    }

    const file = path.join(TMP_DIR, 'crawler.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const hit = lines.find(l => l.includes('[TEST] hello world 42'));
    assert.ok(hit, 'crawler.jsonl should contain the message');
    const entry = JSON.parse(hit);
    assert.strictEqual(entry.nodeCode, 'test-node');
  });
});