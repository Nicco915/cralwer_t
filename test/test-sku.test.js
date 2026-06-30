const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { parseArgs, startMockUploadServer } = require('../test-sku');

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

describe('test-sku startMockUploadServer', () => {
  it('returns upload URL and handles POST /upload', async () => {
    const { server, url, getUploadCount } = await startMockUploadServer();
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({
          sku: 'ABC-001',
          contentType: 'image/jpeg',
          fileName: 'ABC-001_1.jpg',
          imageBase64: 'aGVsbG8=',
        }));
        req.end();
      });

      assert.strictEqual(response.status, 200);
      const data = JSON.parse(response.body);
      assert.strictEqual(data.code, 0);
      assert.strictEqual(data.data.sku, 'ABC-001');
      assert.strictEqual(data.data.contentType, 'image/jpeg');
      assert.strictEqual(data.data.fileName, 'ABC-001_1.jpg');
      assert.strictEqual(getUploadCount(), 1);
    } finally {
      server.close();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const { server, url } = await startMockUploadServer();
    try {
      const baseUrl = url.replace('/upload', '');
      const response = await new Promise((resolve, reject) => {
        const req = http.request(`${baseUrl}/unknown`, { method: 'GET' }, (res) => {
          resolve({ status: res.statusCode });
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(response.status, 404);
    } finally {
      server.close();
    }
  });
});
