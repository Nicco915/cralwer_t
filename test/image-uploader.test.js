const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ImageUploader } = require('../src/image-uploader');

describe('ImageUploader.detectContentType', () => {
  it('detects JPEG by magic bytes', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    assert.equal(ImageUploader.detectContentType(buffer, '.jpg'), 'image/jpeg');
  });

  it('detects PNG by magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(ImageUploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('detects WebP by magic bytes', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    assert.equal(ImageUploader.detectContentType(buffer, '.webp'), 'image/webp');
  });

  it('falls back to extension when magic bytes unknown', () => {
    const buffer = Buffer.from([0, 0, 0]);
    assert.equal(ImageUploader.detectContentType(buffer, '.png'), 'image/png');
  });

  it('prefers magic bytes when extension mismatches', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(ImageUploader.detectContentType(buffer, '.jpg'), 'image/png');
  });

  it('returns null when neither recognized', () => {
    const buffer = Buffer.from([0, 0, 0]);
    assert.equal(ImageUploader.detectContentType(buffer, '.xyz'), null);
  });
});
