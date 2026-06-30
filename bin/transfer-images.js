const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../src/cli');
const { ImageUploader } = require('../src/image-uploader');
const { startMockUploadServer } = require('../src/mock-upload-server');

function parseTransferArgs(argv) {
  const args = (argv || []).filter((a) => a !== undefined && a !== null);
  const paths = [];
  const seen = new Set();
  const options = {
    uploadUrl: undefined,
    uploadConcurrency: undefined,
    uploadRetries: undefined,
    nodeCode: undefined,
    nodeToken: undefined,
    mockUpload: false,
    progress: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const rawKey = eqIndex !== -1 ? arg.slice(2, eqIndex) : arg.slice(2);
      const rawVal = eqIndex !== -1 ? arg.slice(eqIndex + 1) : (() => {
        const next = args[i + 1];
        if (next !== undefined && !String(next).startsWith('--')) { i++; return next; }
        return true;
      })();
      switch (rawKey) {
        case 'upload-url': options.uploadUrl = rawVal; break;
        case 'upload-concurrency': options.uploadConcurrency = Number(rawVal); break;
        case 'upload-retries': options.uploadRetries = Number(rawVal); break;
        case 'node-code': options.nodeCode = rawVal; break;
        case 'node-token': options.nodeToken = rawVal; break;
        case 'mock-upload': options.mockUpload = true; break;
        case 'no-progress': options.progress = false; break;
        default: break;
      }
    } else {
      if (!seen.has(arg)) { seen.add(arg); paths.push(arg); }
    }
  }

  return { paths, options };
}

class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

const _imageUploaderProto = ImageUploader.prototype;

async function transferImages({ paths, options, deps = {} }) {
  const {
    loadEnvFile: loadEnv = () => {},
    pathExists = (p) => fs.existsSync(p),
    readFile = (p) => fs.readFileSync(p),
    startMockUploadServer: startMock = startMockUploadServer,
  } = deps;

  loadEnv(process.cwd());

  const opts = { ...options };

  let mockHandle = null;
  if (opts.mockUpload) {
    mockHandle = await startMock();
    opts.uploadUrl = mockHandle.url;
  }

  const envUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
  if (!opts.uploadUrl && envUrl) opts.uploadUrl = envUrl;

  if (!opts.uploadUrl) {
    if (mockHandle) await mockHandle.close();
    throw new ConfigError('upload url required: pass --upload-url=, set CRAWLER_IMAGE_UPLOAD_URL, or use --mock-upload');
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    if (mockHandle) await mockHandle.close();
    throw new Error('no paths provided');
  }

  for (const p of paths) {
    if (!pathExists(p)) {
      if (mockHandle) await mockHandle.close();
      throw new Error(`path not found: ${p}`);
    }
  }

  const records = paths.map((p) => {
    const stats = fs.statSync(p);
    const buffer = readFile(p);
    const ext = path.extname(p);
    const fileName = path.basename(p);
    const sku = path.basename(fileName, path.extname(fileName));
    const contentType = _imageUploaderProto.detectContentType.call(
      Object.create(_imageUploaderProto), buffer, ext
    );
    return { path: p, buffer, fileName, sku, contentType, fileSize: stats.size, isEmpty: stats.size === 0 };
  });

  const uploadItems = [];
  const results = [];
  for (const r of records) {
    if (r.isEmpty) {
      results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: 0, ok: false, error: 'empty file' });
      continue;
    }
    if (!r.contentType) {
      results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: null, fileSize: r.fileSize, ok: false, error: 'unknown content type' });
      continue;
    }
    uploadItems.push({ fileName: r.fileName, buffer: r.buffer, contentType: r.contentType });
  }

  const fetchImpl = opts.fetchImpl;
  const concurrency = Number.isFinite(opts.uploadConcurrency)
    ? opts.uploadConcurrency
    : (Number(process.env.CRAWLER_IMAGE_UPLOAD_CONCURRENCY) || 2);
  const maxRetries = Number.isFinite(opts.uploadRetries)
    ? opts.uploadRetries
    : (process.env.CRAWLER_IMAGE_UPLOAD_RETRIES !== undefined
        ? Number(process.env.CRAWLER_IMAGE_UPLOAD_RETRIES)
        : 3);
  const nodeCode = opts.nodeCode !== undefined ? opts.nodeCode : (process.env.CRAWLER_NODE_CODE || '');
  const nodeToken = opts.nodeToken !== undefined ? opts.nodeToken : (process.env.CRAWLER_NODE_TOKEN || '');

  const uploader = new ImageUploader({
    uploadUrl: opts.uploadUrl,
    nodeCode,
    nodeToken,
    concurrency,
    maxRetries,
    fetch: fetchImpl,
    skuForImage: (_buf, _index, image) => image.fileName.replace(/\.[^.]+$/, ''),
  });

  if (uploadItems.length > 0) {
    const fakeResult = {
      crawlerTaskId: `cli-transfer-${Date.now()}`,
      status: 'success',
      sku: '',
      image_paths: '',
      _preloadedItems: uploadItems,
    };
    const summary = await uploader.upload(fakeResult);
    const uploadedByFile = new Map(summary.uploaded.map((u) => [u.fileName, u]));
    const failedByFile = new Map(summary.failed.map((f) => [f.fileName, f]));
    for (const r of records) {
      if (r.isEmpty || !r.contentType) continue;
      const u = uploadedByFile.get(r.fileName);
      const f = failedByFile.get(r.fileName);
      if (u) {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: true, response: u.response || { id: u.id } });
      } else if (f) {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: false, error: f.error });
      } else {
        results.push({ path: r.path, sku: r.sku, fileName: r.fileName, contentType: r.contentType, fileSize: r.fileSize, ok: false, error: 'unknown state' });
      }
    }
  }

  if (mockHandle) await mockHandle.close();

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;
  return { total: results.length, success, failed, results };
}

module.exports = { parseTransferArgs, transferImages, ConfigError, main: () => Promise.resolve(0) };