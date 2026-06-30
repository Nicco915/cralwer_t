const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/cli');

describe('image upload CLI configuration', () => {
  it('parses --image-upload-url as string', () => {
    const config = parse(['--image-upload-url', 'https://example.com/upload']);
    assert.strictEqual(config.imageUploadUrl, 'https://example.com/upload');
  });

  it('parses --image-upload-concurrency as number', () => {
    const config = parse(['--image-upload-concurrency', '3']);
    assert.strictEqual(config.imageUploadConcurrency, 3);
  });

  it('parses --image-upload-retries as number', () => {
    const config = parse(['--image-upload-retries', '5']);
    assert.strictEqual(config.imageUploadRetries, 5);
  });

  it('parses --no-image-upload as enableImageUpload=false', () => {
    const config = parse(['--no-image-upload']);
    assert.strictEqual(config.enableImageUpload, false);
  });

  it('falls back to CRAWLER_IMAGE_UPLOAD_URL environment variable', () => {
    process.env.CRAWLER_IMAGE_UPLOAD_URL = 'https://env.example.com/upload';
    try {
      const config = parse([]);
      assert.strictEqual(config.imageUploadUrl, 'https://env.example.com/upload');
    } finally {
      delete process.env.CRAWLER_IMAGE_UPLOAD_URL;
    }
  });

  it('falls back to CRAWLER_IMAGE_UPLOAD_CONCURRENCY environment variable', () => {
    process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY = '4';
    try {
      const config = parse([]);
      assert.strictEqual(config.imageUploadConcurrency, 4);
    } finally {
      delete process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY;
    }
  });

  it('falls back to CRAWLER_IMAGE_UPLOAD_RETRIES environment variable', () => {
    process.env.CRAWLER_IMAGE_UPLOAD_RETRIES = '6';
    try {
      const config = parse([]);
      assert.strictEqual(config.imageUploadRetries, 6);
    } finally {
      delete process.env.CRAWLER_IMAGE_UPLOAD_RETRIES;
    }
  });
});
