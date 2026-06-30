const MAGIC_BYTES = {
  JPEG: [0xFF, 0xD8, 0xFF],
  PNG: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  RIFF: [0x52, 0x49, 0x46, 0x46],
  WEBP: [0x57, 0x45, 0x42, 0x50],
};

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function matchesMagicBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function detectWebp(buffer) {
  if (buffer.length < 12) return false;
  if (!matchesMagicBytes(buffer, MAGIC_BYTES.RIFF)) return false;
  return matchesMagicBytes(buffer.slice(8, 12), MAGIC_BYTES.WEBP);
}

class ImageUploader {
  constructor(options = {}) {
    this.uploadUrl = options.uploadUrl || '';
    this.nodeCode = options.nodeCode || '';
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 5;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
  }

  static detectContentType(buffer, ext) {
    let byMagic = null;

    if (matchesMagicBytes(buffer, MAGIC_BYTES.JPEG)) {
      byMagic = 'image/jpeg';
    } else if (matchesMagicBytes(buffer, MAGIC_BYTES.PNG)) {
      byMagic = 'image/png';
    } else if (detectWebp(buffer)) {
      byMagic = 'image/webp';
    }

    const byExt = ext ? EXT_TO_MIME[ext.toLowerCase()] || null : null;

    if (byMagic && byExt && byMagic !== byExt) {
      console.warn(`Content-Type mismatch: magic bytes indicate ${byMagic}, but extension ${ext} indicates ${byExt}. Using magic bytes.`);
    }

    return byMagic || byExt || null;
  }
}

module.exports = { ImageUploader };
