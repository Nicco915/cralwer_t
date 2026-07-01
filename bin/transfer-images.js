const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { loadEnvFile } = require('../src/cli');
const { ImageUploader } = require('../src/image-uploader');
const { startMockUploadServer } = require('../src/mock-upload-server');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const BOOLEAN_FLAGS = new Set(['mock-upload', 'no-progress', 'recursive', 'quiet', 'force']);

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
    // New flags for batch / monitored usage:
    dir: undefined,
    recursive: false,
    logFile: undefined,
    quiet: false,
    stateFile: undefined,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const rawKey = eqIndex !== -1 ? arg.slice(2, eqIndex) : arg.slice(2);
      let rawVal;
      if (eqIndex !== -1) {
        rawVal = arg.slice(eqIndex + 1);
      } else if (BOOLEAN_FLAGS.has(rawKey)) {
        rawVal = true;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !String(next).startsWith('--')) {
          i++;
          rawVal = next;
        } else {
          rawVal = true;
        }
      }
      switch (rawKey) {
        case 'upload-url': options.uploadUrl = rawVal; break;
        case 'upload-concurrency': options.uploadConcurrency = Number(rawVal); break;
        case 'upload-retries': options.uploadRetries = Number(rawVal); break;
        case 'node-code': options.nodeCode = rawVal; break;
        case 'node-token': options.nodeToken = rawVal; break;
        case 'mock-upload': options.mockUpload = true; break;
        case 'no-progress': options.progress = false; break;
        case 'dir':
        case 'folder': options.dir = rawVal; break;
        case 'recursive': options.recursive = true; break;
        case 'log-file': options.logFile = rawVal; break;
        case 'quiet': options.quiet = true; break;
        case 'state-file': options.stateFile = rawVal; break;
        case 'force': options.force = true; break;
        default:
          console.warn(`[transfer-images] unknown option: --${rawKey}`);
          break;
      }
    } else {
      if (!seen.has(arg)) { seen.add(arg); paths.push(arg); }
    }
  }

  return { paths, options };
}

// Recursively scan a directory for image files, sorted by full path.
// `recursive=false` only walks the top level.
async function scanImages(dir, recursive = false) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) {
        const nested = await scanImages(p, true);
        out.push(...nested);
      }
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) out.push(p);
    }
  }
  return out.sort();
}

function loadState(stateFile, deps = {}) {
  const logger = deps.logger || null;
  if (!fs.existsSync(stateFile)) return new Map();
  const content = fs.readFileSync(stateFile, 'utf-8');
  const map = new Map();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.basename === 'string' && !map.has(entry.basename)) {
        map.set(entry.basename, entry);
      }
    } catch (_e) {
      if (logger) logger.warn(`skipping malformed state line: ${line.slice(0, 80)}`);
    }
  }
  return map;
}

function appendState(stateFile, entry, deps = {}) {
  const logger = deps.logger || null;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.appendFileSync(stateFile, JSON.stringify(entry) + '\n');
  } catch (e) {
    if (logger) logger.error(`failed to append state: ${e.message}`);
  }
}

function defaultStatePath(dir) {
  const resolved = path.resolve(dir);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(process.cwd(), '.transfer-state', `${hash}.ndjson`);
}

// Build a logger that can write to stdout, append to a file, or both,
// suitable for `tail -f` monitoring of long batch uploads.
function makeLogger({ quiet = false, logFile = null } = {}) {
  const ts = () => new Date().toISOString();
  const write = (line) => {
    if (!quiet) process.stdout.write(line + '\n');
    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + '\n');
      } catch (e) {
        process.stderr.write(`[logger] failed to write log file: ${e.message}\n`);
      }
    }
  };
  return {
    info: (msg) => write(`[${ts()}] [INFO] ${msg}`),
    warn: (msg) => write(`[${ts()}] [WARN] ${msg}`),
    error: (msg) => write(`[${ts()}] [ERROR] ${msg}`),
    uploadStart: (i, total, fileName, sizeKB) =>
      write(`[${ts()}] [UPLOAD] [${i}/${total}] ${fileName} (${sizeKB} KB) ...`),
    uploadOk: (i, total, fileName, id) =>
      write(`[${ts()}] [UPLOAD] [${i}/${total}] ${fileName} ... ok (id=${id ?? '?'})`),
    uploadFail: (i, total, fileName, err) =>
      write(`[${ts()}] [UPLOAD] [${i}/${total}] ${fileName} ... FAIL (${err})`),
  };
}

class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

async function transferImages({ paths, options, deps = {} }) {
  const {
    loadEnvFile: loadEnv = loadEnvFile,
    pathExists = (p) => fs.existsSync(p),
    readFile = (p) => fs.readFileSync(p),
    startMockUploadServer: startMock = startMockUploadServer,
    scanImages: scanDep = scanImages,
    loadState: loadStateDep = loadState,
    appendState: appendStateDep = appendState,
    defaultStatePath: defaultStatePathDep = defaultStatePath,
  } = deps;

  loadEnv(process.cwd());

  const opts = { ...options };
  const logger = makeLogger({ quiet: opts.quiet, logFile: opts.logFile });

  let mockHandle = null;
  try {
    if (opts.mockUpload) {
      mockHandle = await startMock();
      opts.uploadUrl = mockHandle.url;
    }

    const envUrl = process.env.CRAWLER_IMAGE_UPLOAD_URL;
    if (!opts.uploadUrl && envUrl) opts.uploadUrl = envUrl;

    if (!opts.uploadUrl) {
      throw new ConfigError('upload url required: pass --upload-url=, set CRAWLER_IMAGE_UPLOAD_URL, or use --mock-upload');
    }

    // Expand --dir into individual image paths
    let allPaths = [...paths];
    if (opts.dir) {
      if (!pathExists(opts.dir)) {
        throw new Error(`directory not found: ${opts.dir}`);
      }
      const scanned = await scanDep(opts.dir, !!opts.recursive);
      logger.info(`Scanned ${scanned.length} images from ${opts.dir}${opts.recursive ? ' (recursive)' : ''}`);
      allPaths = allPaths.concat(scanned);
    }
    // Dedup, preserve order
    const seenSet = new Set();
    allPaths = allPaths.filter((p) => (seenSet.has(p) ? false : (seenSet.add(p), true)));

    if (!Array.isArray(allPaths) || allPaths.length === 0) {
      throw new Error('no paths provided (pass positional paths or --dir=)');
    }

    for (const p of allPaths) {
      if (!pathExists(p)) {
        throw new Error(`path not found: ${p}`);
      }
    }

    // ★ Resolve state file path
    const stateFile = opts.stateFile
      || (opts.dir ? defaultStatePathDep(opts.dir) : null);

    // ★ Load existing state (basename → entry)
    const doneMap = stateFile ? loadStateDep(stateFile, { logger }) : new Map();
    if (stateFile && doneMap.size > 0) {
      logger.info(`State: ${doneMap.size} basenames already uploaded at ${stateFile}`);
    }

    // ★ Filter skipped (basename in doneMap) unless --force
    const skipped = [];
    let toUpload = allPaths;
    if (!opts.force && doneMap.size > 0) {
      const before = allPaths.length;
      toUpload = allPaths.filter((p) => {
        const basename = path.basename(p);
        if (doneMap.has(basename)) {
          skipped.push({ basename, sku: doneMap.get(basename).sku });
          return false;
        }
        return true;
      });
      if (before !== toUpload.length) {
        logger.info(`Resume: skipping ${before - toUpload.length} already-uploaded, ${toUpload.length} to upload`);
      }
    } else if (opts.force && doneMap.size > 0) {
      logger.info(`--force set: ignoring state, will upload all ${toUpload.length}`);
    }

    logger.info(`Starting transfer: ${toUpload.length} images, uploadUrl=${opts.uploadUrl}`);

    // ★ Async iterator: yields { path, fileName, ext, sku, size, contentType } — NO buffer
    //    Worker reads buffer inside limitConcurrency (single readFileSync < 200KB)
    async function* iter() {
      for (const p of toUpload) {
        const stats = fs.statSync(p);
        const ext = path.extname(p);
        const fileName = path.basename(p);
        const sku = fileName.replace(/_\d+\.[^.]+$/, '');
        yield { path: p, fileName, ext, sku, size: stats.size };
      }
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
    });

    const startTime = Date.now();
    const summary = { uploaded: [], failed: [], skipped: [] };
    const workerOutputs = []; // preserve order: { status, data|error, item }

    if (toUpload.length > 0) {
      // ★ Materialize iter into array for limitConcurrency's index access
      //    Materialize phase only stats (no readFile)
      const arr = [];
      let idx = 0;
      for await (const item of iter()) {
        arr.push({ item, index: idx++ });
      }

      const outputs = await uploader.limitConcurrency(
        arr,
        async ({ item, index }) => {
          // ★ 流式核心：在 worker 内同步 readFile
          let buffer;
          try {
            buffer = readFile(item.path);
          } catch (e) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, `read failed: ${e.message}`);
            return { status: 'failed', fileName: item.fileName, error: `read failed: ${e.message}`, item };
          }
          const contentType = ImageUploader.prototype.detectContentType(buffer, item.ext);
          if (!contentType) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, 'unknown content type');
            return { status: 'failed', fileName: item.fileName, error: 'unknown content type', contentType: null, item };
          }
          if (buffer.length === 0) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, 'empty file');
            return { status: 'failed', fileName: item.fileName, error: 'empty file', contentType, item };
          }

          const sku = item.sku;
          const payload = uploader.buildPayload(sku, item.fileName, buffer, contentType);
          const sizeKB = Math.ceil(item.size / 1024);
          logger.uploadStart(index + 1, toUpload.length, item.fileName, sizeKB);
          try {
            const data = await uploader.uploadSingle(payload);
            logger.uploadOk(index + 1, toUpload.length, item.fileName, data.id);

            // ★ 成功后写 state
            if (stateFile) {
              appendStateDep(stateFile, {
                basename: item.fileName,
                sku,
                id: data.id,
                ts: new Date().toISOString(),
                uploadUrl: opts.uploadUrl,
              }, { logger });
            }

            return { status: 'uploaded', data, contentType, item };
          } catch (error) {
            logger.uploadFail(index + 1, toUpload.length, item.fileName, error.message);
            return { status: 'failed', fileName: item.fileName, error: error.message, contentType, item };
          }
        },
        Math.max(1, concurrency)
      );

      for (const o of outputs) {
        workerOutputs.push(o);
        if (o.status === 'uploaded') {
          summary.uploaded.push(o.data);
        } else {
          summary.failed.push({ fileName: o.fileName, error: o.error });
        }
      }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const attempted = summary.uploaded.length + summary.failed.length;
    const rate = elapsedSec > 0 ? (attempted / Number(elapsedSec)).toFixed(2) : '0.00';
    logger.info(`Done: ${attempted} attempted, ${summary.uploaded.length} success, ${summary.failed.length} failed, ${elapsedSec}s elapsed, ${rate} img/s`);

    // ★ Build final results with consistent shape (uploaded/failed/skipped all share fields)
    const results = [];
    for (const o of workerOutputs) {
      const item = o.item;
      if (o.status === 'uploaded') {
        results.push({
          path: item.path, sku: item.sku, fileName: item.fileName,
          contentType: o.contentType, fileSize: item.size,
          ok: true, response: o.data.response || { id: o.data.id },
        });
      } else {
        results.push({
          path: item.path, sku: item.sku, fileName: item.fileName,
          contentType: o.contentType !== undefined ? o.contentType : null, fileSize: item.size,
          ok: false, error: o.error,
        });
      }
    }
    // 2. skipped items (from state recovery)
    for (const s of skipped) {
      results.push({
        path: s.basename, sku: s.sku, fileName: s.basename,
        contentType: null, fileSize: 0,
        ok: true, skipped: true,
      });
    }

    const success = results.filter((r) => r.ok).length;
    const failed = results.length - success;
    return { total: results.length, success, failed, results };
  } finally {
    if (mockHandle) {
      try { await mockHandle.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function main(argv) {
  try {
    const { paths, options } = parseTransferArgs(argv || process.argv.slice(2));
    const report = await transferImages({ paths, options });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.success > 0 ? 0 : 1;
  } catch (err) {
    const code = err.name === 'ConfigError' ? 2 : 1;
    process.stderr.write(`[transfer-images] ${err.message}\n`);
    process.stdout.write(JSON.stringify({
      total: 0, success: 0, failed: 0, results: [], error: err.message,
    }, null, 2) + '\n');
    return code;
  }
}

module.exports = {
  parseTransferArgs,
  transferImages,
  scanImages,
  makeLogger,
  loadState,
  appendState,
  defaultStatePath,
  IMAGE_EXTS,
  ConfigError,
  main,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(String(e.stack || e) + '\n');
    process.exit(1);
  });
}