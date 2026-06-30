const fs = require('fs');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });

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
  if (!buffer || buffer.length < 12) return false;
  if (!matchesMagicBytes(buffer, MAGIC_BYTES.RIFF)) return false;
  return matchesMagicBytes(buffer.slice(8, 12), MAGIC_BYTES.WEBP);
}

function isNonRetryableError(error) {
  const message = (error && error.message) || '';
  if (/\b4\d{2}\b/.test(message)) {
    // 400, 401, 403, 404, etc. are client errors; do not retry
    return true;
  }
  return false;
}

function resolveImageSku(uploader, buf, index, imageRecord, result) {
  if (typeof uploader.skuForImage === 'function') {
    return uploader.skuForImage(buf, index, imageRecord);
  }
  if (uploader.nodeCode) return `${uploader.nodeCode}_${index}`;
  if (result && result.crawlerTaskId) return `${result.crawlerTaskId}_${index}`;
  return '';
}

class ImageUploader {
  constructor(options = {}) {
    this.uploadUrl = options.uploadUrl || '';
    this.nodeCode = options.nodeCode || '';
    this.nodeToken = options.nodeToken || '';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
    this.skuForImage = typeof options.skuForImage === 'function'
      ? options.skuForImage
      : null;
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
      console.warn(`[IMAGE_UPLOAD] Content-Type mismatch: magic bytes indicate ${byMagic}, but extension ${ext} indicates ${byExt}. Using magic bytes.`);
    }

    return byMagic || byExt || null;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildPayload(sku, fileName, buffer, contentType) {
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
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`[IMAGE_UPLOAD] Retrying ${payload.fileName}, attempt ${attempt}/${this.maxRetries}`);
        await this.sleep(this.retryDelays[attempt - 1] || 4000);
      }
      try {
        const response = await this.fetch(this.uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSONbig.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Upload failed: ${response.status} ${text}`);
        }

        const data = await response.json().catch(() => ({}));
        return { id: data.data?.id, fileName: payload.fileName };
      } catch (error) {
        lastError = error;
        console.error(`[IMAGE_UPLOAD] Failed ${payload.fileName} attempt ${attempt}: ${error.message}`);
        if (isNonRetryableError(error)) {
          break;
        }
      }
    }
    throw lastError || new Error('Upload failed after retries');
  }

  async limitConcurrency(items, fn, limit) {
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  async upload(result) {
    const summary = {
      sku: result.sku,
      uploaded: [],
      failed: [],
      skipped: [],
    };

    if (result.status !== 'success') return summary;
    if (!Array.isArray(result._preloadedItems) && !result.image_paths) return summary;

    const usePreloaded = Array.isArray(result._preloadedItems);
    const uploadItems = usePreloaded
      ? result._preloadedItems
      : this._resolveFromPaths(result.image_paths, summary);

    if (uploadItems.length === 0) return summary;

    const indexed = uploadItems.map((item, index) => ({ item, index }));

    const outputs = await this.limitConcurrency(
      indexed,
      async ({ item, index }) => {
        try {
          const sku = usePreloaded
            ? resolveImageSku(this, item.buffer, index, item, result)
            : result.sku;
          const payload = this.buildPayload(sku, item.fileName, item.buffer, item.contentType);
          const data = await this.uploadSingle(payload);
          return { status: 'uploaded', data };
        } catch (error) {
          return { status: 'failed', fileName: item.fileName, error: error.message };
        }
      },
      Math.max(1, this.concurrency)
    );

    for (const output of outputs) {
      if (output.status === 'uploaded') {
        summary.uploaded.push(output.data);
      } else {
        summary.failed.push({ fileName: output.fileName, error: output.error });
      }
    }

    return summary;
  }

  _resolveFromPaths(imagePaths, summary) {
    const uploadItems = [];
    const paths = String(imagePaths).split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    for (const filePath of paths) {
      const fileName = path.basename(filePath);
      if (!fs.existsSync(filePath)) {
        summary.skipped.push({ fileName, reason: 'file not found' });
        continue;
      }
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        summary.failed.push({ fileName, error: 'empty file' });
        continue;
      }
      const ext = path.extname(filePath);
      let buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch (e) {
        summary.failed.push({ fileName, error: `read failed: ${e.message}` });
        continue;
      }
      const contentType = this.detectContentType(buffer, ext);
      if (!contentType) {
        summary.failed.push({ fileName, error: 'unknown content type' });
        continue;
      }
      uploadItems.push({ fileName, buffer, contentType });
    }
    return uploadItems;
  }
}

module.exports = { ImageUploader };
