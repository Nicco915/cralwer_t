const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VevorCrawler } = require('../src/crawler');

describe('VevorCrawler checkpoint', () => {
  let tmpDir;
  let crawler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-test-'));
    crawler = new VevorCrawler({
      inputExcel: path.join(tmpDir, 'input.xlsx'),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadCheckpoint returns default structure including mismatched_skus', () => {
    const checkpoint = crawler.loadCheckpoint();
    assert.deepStrictEqual(checkpoint, {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
      current_batch: 1,
      last_processed_index: -1,
    });
  });

  it('loadCheckpoint merges missing fields from defaults', () => {
    const checkpointFile = path.join(tmpDir, 'checkpoint.json');
    fs.writeFileSync(checkpointFile, JSON.stringify({
      completed_skus: ['A-001'],
      failed_skus: [],
      not_found_skus: [],
      current_batch: 2,
      last_processed_index: 0,
    }), 'utf-8');

    crawler.config.checkpointFile = checkpointFile;
    const checkpoint = crawler.loadCheckpoint();
    assert.deepStrictEqual(checkpoint.mismatched_skus, []);
    assert.deepStrictEqual(checkpoint.completed_skus, ['A-001']);
  });

  it('classifyResult puts sku_mismatch into mismatched_skus', () => {
    const checkpoint = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
    };
    crawler.classifyResult(checkpoint, { sku: 'A-123', status: 'sku_mismatch' });
    assert.deepStrictEqual(checkpoint.mismatched_skus, ['A-123']);
    assert.deepStrictEqual(checkpoint.failed_skus, []);
  });

  it('classifyResult puts error into failed_skus', () => {
    const checkpoint = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
    };
    crawler.classifyResult(checkpoint, { sku: 'A-123', status: 'error' });
    assert.deepStrictEqual(checkpoint.failed_skus, ['A-123']);
  });
});
