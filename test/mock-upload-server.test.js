const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startMockUploadServer } = require('../src/mock-upload-server');

describe('startMockUploadServer', () => {
  it('returns URL and handles POST /upload', async () => {
    const handle = await startMockUploadServer();
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.request(handle.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(JSON.stringify({
          sku: 'X', contentType: 'image/jpeg',
          fileName: 'x.jpg', imageBase64: 'aGVsbG8=',
        }));
        req.end();
      });
      assert.equal(response.status, 200);
      const data = JSON.parse(response.body);
      assert.equal(data.code, 0);
      assert.equal(handle.getUploadCount(), 1);
    } finally {
      handle.close();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const handle = await startMockUploadServer();
    try {
      const base = handle.url.replace('/upload', '');
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/no`, { method: 'GET' }, (res) => resolve(res.statusCode));
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 404);
    } finally {
      handle.close();
    }
  });
});
