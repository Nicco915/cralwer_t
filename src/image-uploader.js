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

const fs = require('fs');
const path = require('path');

function matchesMagicBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function detectWebp(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (!matchesMagicBytes(buffer, MAGIC_BYTES.RIFF)) return false;
  return matchesMagicBytes(buffer.slice(8, 12), MAGIC_BYTES.WEBP);
}

class ImageUploader {
  constructor(options = {}) {
    this.uploadUrl = options.uploadUrl || '';
    this.nodeCode = options.nodeCode || '';
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
  }

  detectContentType(buffer, ext) {
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildPayload(sku, filePath, contentType) {
    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    return {
      nodeCode: this.nodeCode,
      nodeToken: this.nodeToken,
      sku,
      contentType,
      fileName,
      imageBase64: buffer.toString('base64'),
    };
  }

  async uploadSingle(payload) {
    let lastError = null;
    const attempts = Math.max(1, this.maxRetries);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.fetch(this.uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result.code !== 0) {
          throw new Error(`API error: ${result.code}`);
        }
        return result.data;
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1 && this.retryDelays[attempt]) {
          await this.sleep(this.retryDelays[attempt]);
        }
      }
    }
    throw lastError || new Error('Upload failed after retries');
  }

  async limitConcurrency(items, fn, limit) {
    const results = [];
    const executing = [];
    for (const [index, item] of items.entries()) {
      const promise = fn(item).then((value) => ({ index, value }));
      results.push(promise);
      if (results.length >= limit) {
        executing.push(promise);
        if (executing.length >= limit) {
          await Promise.race(executing);
        }
      }
      promise.finally(() => {
        const i = executing.indexOf(promise);
        if (i !== -1) executing.splice(i, 1);
      });
    }
    const settled = await Promise.all(results);
    settled.sort((a, b) => a.index - b.index);
    return settled.map((s) => s.value);
  }

  upload(result) {
    return new Promise((resolve) => {
      resolve(this._upload(result));
    });
  }

  async _upload(result) {
    const sku = result.sku;
    const uploaded = [];
    const failed = [];
    const skipped = [];

    if (result.status !== 'success' || !result.image_paths) {
      return { sku, uploaded, failed, skipped };
    }

    const paths = String(result.image_paths)
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);

    const uploadItems = [];
    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) {
        skipped.push({ path: filePath, reason: 'not_found' });
        continue;
      }
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        skipped.push({ path: filePath, reason: 'empty_file' });
        continue;
      }
      const ext = path.extname(filePath);
      const contentType = this.detectContentType(null, ext);
      if (!contentType) {
        skipped.push({ path: filePath, reason: 'unknown_content_type' });
        continue;
      }
      uploadItems.push({ filePath, contentType });
    }

    if (uploadItems.length === 0) {
      return { sku, uploaded, failed, skipped };
    }

    const outputs = await this.limitConcurrency(
      uploadItems,
      async (item) => {
        try {
          const payload = this.buildPayload(sku, item.filePath, item.contentType);
          const data = await this.uploadSingle(payload);
          return { status: 'uploaded', data };
        } catch (error) {
          return { status: 'failed', path: item.filePath, error: error.message };
        }
      },
      Math.max(1, this.concurrency)
    );

    for (const output of outputs) {
      if (output.status === 'uploaded') {
        uploaded.push(output.data);
      } else {
        failed.push({ path: output.path, error: output.error });
      }
    }

    return { sku, uploaded, failed, skipped };
  }
}

module.exports = { ImageUploader };
