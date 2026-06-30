const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../test-sku');

describe('test-sku parseArgs', () => {
  it('uses default SKU when no positional argument', () => {
    const args = parseArgs(['node', 'test-sku.js']);
    assert.strictEqual(args.sku, 'GXSBSJSGWLGXVOLJBV0');
    assert.strictEqual(args.mockUpload, false);
  });

  it('parses SKU positional argument', () => {
    const args = parseArgs(['node', 'test-sku.js', 'ABC-001']);
    assert.strictEqual(args.sku, 'ABC-001');
  });

  it('detects --mock-upload flag', () => {
    const args = parseArgs(['node', 'test-sku.js', 'ABC-001', '--mock-upload']);
    assert.strictEqual(args.sku, 'ABC-001');
    assert.strictEqual(args.mockUpload, true);
  });

  it('parses --proxy override', () => {
    const args = parseArgs(['node', 'test-sku.js', '--proxy=http://proxy:8080']);
    assert.strictEqual(args.rawConfig.proxy, 'http://proxy:8080');
  });
});
