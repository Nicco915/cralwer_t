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
  const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);

  it('uploads a single image and returns id', async () => {
    const sku = 'ABC-001';
    const { dir, filePath } = createTempImage('test.jpg', jpegBuffer);

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
            fileSize: jpegBuffer.length,
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

    try {
      const result = await uploader.upload({
        crawlerTaskId: 1,
        sku,
        status: 'success',
        image_paths: filePath,
      });

      assert.equal(result.sku, sku);
      assert.equal(result.uploaded.length, 1);
      assert.equal(result.uploaded[0].id, 123);
      assert.equal(result.uploaded[0].fileName, 'test.jpg');
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
      assert.equal(payload.imageBase64, jpegBuffer.toString('base64'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers magic bytes over extension in upload payload', async () => {
    const { dir, filePath } = createTempImage('misnamed.png', jpegBuffer);

    let capturedRequest = null;
    const fakeFetch = async (url, init) => {
      capturedRequest = { url, init };
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { id: 1, contentType: body.contentType, fileName: body.fileName } }),
      };
    };

    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload', fetch: fakeFetch });

    try {
      await uploader.upload({ sku: 'SKU-MISNAMED', status: 'success', image_paths: filePath });
      assert.ok(capturedRequest);
      const payload = JSON.parse(capturedRequest.init.body);
      assert.equal(payload.contentType, 'image/jpeg');
      assert.equal(payload.fileName, 'misnamed.png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies missing file as skipped', async () => {
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    const result = await uploader.upload({ sku: 'ABC', status: 'success', image_paths: '/non/existent/file.jpg' });
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].fileName, 'file.jpg');
    assert.equal(result.failed.length, 0);
    assert.equal(result.uploaded.length, 0);
  });

  it('classifies empty file as failed', async () => {
    const { dir, filePath } = createTempImage('empty.jpg', Buffer.alloc(0));
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    try {
      const result = await uploader.upload({ sku: 'ABC', status: 'success', image_paths: filePath });
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].fileName, 'empty.jpg');
      assert.equal(result.skipped.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies unknown content type as failed', async () => {
    const { dir, filePath } = createTempImage('unknown.xyz', Buffer.from([0x01, 0x02, 0x03]));
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    try {
      const result = await uploader.upload({ sku: 'ABC', status: 'success', image_paths: filePath });
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].fileName, 'unknown.xyz');
      assert.equal(result.skipped.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not upload for non-success status', async () => {
    const { dir, filePath } = createTempImage('skip.jpg', jpegBuffer);
    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload' });
    try {
      const result = await uploader.upload({ sku: 'ABC', status: 'error', image_paths: filePath });
      assert.equal(result.uploaded.length, 0);
      assert.equal(result.failed.length, 0);
      assert.equal(result.skipped.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fail other images when one upload fails', async () => {
    const { dir: dir1, filePath: fp1 } = createTempImage('first.jpg', jpegBuffer);
    const { dir: dir2, filePath: fp2 } = createTempImage('second.jpg', jpegBuffer);

    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('network error');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { id: 456 } }),
      };
    };

    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload', maxRetries: 0, fetch: fakeFetch });

    try {
      const result = await uploader.upload({ sku: 'ABC', status: 'success', image_paths: `${fp1};${fp2}` });
      assert.equal(result.uploaded.length, 1);
      assert.equal(result.uploaded[0].id, 456);
      assert.equal(result.failed.length, 1);
      assert.equal(result.skipped.length, 0);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('limits concurrency', async () => {
    const { dir: dir1, filePath: fp1 } = createTempImage('c1.jpg', jpegBuffer);
    const { dir: dir2, filePath: fp2 } = createTempImage('c2.jpg', jpegBuffer);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const fakeFetch = async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      currentConcurrent--;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({ uploadUrl: 'http://example.com/upload', concurrency: 1, fetch: fakeFetch });

    try {
      await uploader.upload({ sku: 'ABC', status: 'success', image_paths: `${fp1};${fp2}` });
      assert.equal(maxConcurrent, 1);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('retries on 5xx and does not retry on 4xx', async () => {
    const { dir, filePath } = createTempImage('retry.jpg', jpegBuffer);

    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, text: async () => 'Server Error' };
      }
      if (callCount === 2) {
        return { ok: false, status: 400, text: async () => 'Bad Request' };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      maxRetries: 3,
      retryDelays: [10, 10, 10],
      fetch: fakeFetch,
    });

    try {
      const result = await uploader.upload({ sku: 'ABC', status: 'success', image_paths: filePath });
      assert.equal(result.failed.length, 1);
      assert.equal(callCount, 2); // 500 retried once, then 400 not retried
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ImageUploader skuForImage hook', () => {
  const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);

  it('uses skuForImage hook for payload.sku when provided', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.sku);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      fetch: fakeFetch,
      skuForImage: (buf, index, img) => `HOOK_${index}_${img.fileName}`,
    });

    const summary = await uploader.upload({
      crawlerTaskId: 't1',
      status: 'success',
      sku: '',
      image_paths: '',
      _preloadedItems: [
        { fileName: 'a.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
        { fileName: 'b.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
      ],
    });

    assert.equal(summary.uploaded.length, 2);
    assert.equal(summary.failed.length, 0);
    assert.deepEqual(seen, ['HOOK_0_a.jpg', 'HOOK_1_b.jpg']);
  });

  it('falls back to legacy sku assembly when skuForImage not provided', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.sku);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    const uploader = new ImageUploader({
      uploadUrl: 'http://example.com/upload',
      nodeCode: 'NODE42',
      fetch: fakeFetch,
    });

    await uploader.upload({
      crawlerTaskId: 't1',
      status: 'success',
      sku: 'GLOBAL',
      image_paths: '',
      _preloadedItems: [
        { fileName: 'a.jpg', buffer: jpegBuffer, contentType: 'image/jpeg' },
      ],
    });

    assert.deepEqual(seen, ['NODE42_0']);
  });
});
