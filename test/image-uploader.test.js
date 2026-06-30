const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ImageUploader } = require('../src/image-uploader');

function createTempImage(filename, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-uploader-'));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return { dir, filePath };
}
describe('ImageUploader.detectContentType', () => {
  let uploader;

  beforeEach(() => {
    uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
  });

  it('detects JPEG by magic bytes', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    assert.equal(uploader.detectContentType(buffer, '.jpg'), 'image/jpeg');
  });

  it('detects PNG by magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(uploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('detects WebP by magic bytes', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    assert.equal(uploader.detectContentType(buffer, '.webp'), 'image/webp');
  });

  it('falls back to extension when magic bytes unknown', () => {
    const buffer = Buffer.from([0, 0, 0]);
    assert.equal(uploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('prefers magic bytes when extension mismatches', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(uploader.detectContentType(buffer, '.jpg'), 'image/png');
  });

  it('returns null when neither recognized', () => {
    const buffer = Buffer.from([0, 0, 0]);
    assert.equal(uploader.detectContentType(buffer, '.xyz'), null);
  });

  it('falls back to extension for null buffer', () => {
    assert.equal(uploader.detectContentType(null, '.jpg'), 'image/jpeg');
  });

  it('falls back to extension for empty buffer', () => {
    assert.equal(uploader.detectContentType(Buffer.alloc(0), '.png'), 'image/png');
  });

  it('falls back to extension for short WebP candidate buffer', () => {
    const buffer = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    assert.equal(uploader.detectContentType(buffer, '.webp'), 'image/webp');
  });
});

describe('ImageUploader.upload', () => {
  it('uploads a single image and returns id', async () => {
    const sku = 'ABC-001';
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    const { dir, filePath } = createTempImage('test.jpg', buffer);

    let capturedRequest = null;
    const fakeFetch = async (url, init) => {
      capturedRequest = { url, init };
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            id: 123,
            sku: body.sku,
            contentType: body.contentType,
            fileName: body.fileName,
            fileSize: buffer.length,
          },
        }),
      };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      nodeCode: 'NODE01',
      nodeToken: 'TOKEN01',
      fetch: fakeFetch,
    });

    const result = await uploader.upload({
      crawlerTaskId: 1,
      sku,
      status: 'success',
      image_paths: filePath,
    });

    try {
      assert.equal(result.sku, sku);
      assert.equal(result.uploaded.length, 1);
      assert.equal(result.uploaded[0].id, 123);
      assert.equal(result.failed.length, 0);
      assert.equal(result.skipped.length, 0);

      assert.ok(capturedRequest);
      assert.equal(capturedRequest.url, 'http://example.com/upload');
      const payload = JSON.parse(capturedRequest.init.body);
      assert.equal(payload.nodeCode, 'NODE01');
      assert.equal(payload.nodeToken, 'TOKEN01');
      assert.equal(payload.sku, sku);
      assert.equal(payload.contentType, 'image/jpeg');
      assert.equal(payload.fileName, 'test.jpg');
      assert.equal(payload.imageBase64, buffer.toString('base64'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
