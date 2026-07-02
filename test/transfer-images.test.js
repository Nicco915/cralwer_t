const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseTransferArgs,
  transferImages,
  loadState,
  appendState,
  defaultStatePath,
} = require('../bin/transfer-images');

describe('parseTransferArgs', () => {
  it('returns defaults for empty argv', () => {
    const r = parseTransferArgs([]);
    assert.deepEqual(r.paths, []);
    assert.equal(r.options.progress, true);
    assert.equal(r.options.mockUpload, false);
  });

  it('collects positional paths in order', () => {
    const r = parseTransferArgs(['a.jpg', 'b.png', 'c.webp']);
    assert.deepEqual(r.paths, ['a.jpg', 'b.png', 'c.webp']);
  });

  it('deduplicates positional paths keeping first', () => {
    const r = parseTransferArgs(['a.jpg', 'b.png', 'a.jpg']);
    assert.deepEqual(r.paths, ['a.jpg', 'b.png']);
  });

  it('parses --upload-url', () => {
    const r = parseTransferArgs(['--upload-url=http://x.com/up']);
    assert.equal(r.options.uploadUrl, 'http://x.com/up');
  });

  it('parses --upload-concurrency as number', () => {
    const r = parseTransferArgs(['--upload-concurrency=4']);
    assert.equal(r.options.uploadConcurrency, 4);
  });

  it('parses --upload-retries as number', () => {
    const r = parseTransferArgs(['--upload-retries=5']);
    assert.equal(r.options.uploadRetries, 5);
  });

  it('parses --mock-upload boolean', () => {
    const r = parseTransferArgs(['--mock-upload']);
    assert.equal(r.options.mockUpload, true);
  });

  it('parses --no-progress to false', () => {
    const r = parseTransferArgs(['--no-progress']);
    assert.equal(r.options.progress, false);
  });

  it('parses --node-code and --node-token', () => {
    const r = parseTransferArgs(['--node-code=NC', '--node-token=NT']);
    assert.equal(r.options.nodeCode, 'NC');
    assert.equal(r.options.nodeToken, 'NT');
  });

  it('parses --state-file', () => {
    const r = parseTransferArgs(['--state-file=/tmp/custom.ndjson']);
    assert.equal(r.options.stateFile, '/tmp/custom.ndjson');
  });

  it('parses --force', () => {
    const r = parseTransferArgs(['--force']);
    assert.equal(r.options.force, true);
  });
});

describe('transferImages', () => {
  const os = require('os');

  function makeImage(filename, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-'));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
  }

  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('uploads a single JPEG and returns ok=true', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    const { filePath } = makeImage('A_1.jpg', buf);

    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 9, sku: 'A' } }) };
    };

    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });

    assert.equal(report.total, 1);
    assert.equal(report.success, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].ok, true);
    assert.equal(report.results[0].sku, 'A');
    assert.equal(report.results[0].fileName, 'A_1.jpg');
    assert.equal(captured.url, 'http://test/up');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.sku, 'A');
    assert.equal(body.contentType, 'image/jpeg');
    assert.equal(body.fileName, 'A_1.jpg');
  });

  it('continues when one of multiple fails', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const a = makeImage('A.jpg', buf);
    const b = makeImage('B.jpg', buf);

    let n = 0;
    const fakeFetch = async () => {
      n++;
      if (n === 1) return { ok: false, status: 500, text: async () => 'oops' };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: n } }) };
    };

    const report = await transferImages({
      paths: [a.filePath, b.filePath],
      options: { uploadUrl: 'http://test/up', uploadRetries: 0, fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });

    assert.equal(report.total, 2);
    assert.equal(report.success, 1);
    assert.equal(report.failed, 1);
    const failed = report.results.find((r) => !r.ok);
    assert.match(failed.error, /500/);
  });

  it('marks empty file as failed without calling fetch', async () => {
    const { filePath } = makeImage('empty.jpg', Buffer.alloc(0));
    let called = false;
    const fakeFetch = async () => { called = true; throw new Error('should not call'); };
    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });
    assert.equal(report.total, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.success, 0);
    assert.equal(called, false);
    assert.equal(report.results[0].error, 'empty file');
  });

  it('marks unknown content type as failed', async () => {
    const buf = Buffer.from([0, 0, 0, 0]);
    const { filePath } = makeImage('mystery.xyz', buf);
    const fakeFetch = async () => { throw new Error('should not call'); };
    const report = await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });
    assert.equal(report.failed, 1);
    assert.equal(report.results[0].error, 'unknown content type');
  });

  it('infers SKU from fileName stripping _N suffix and extension', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const { filePath } = makeImage('XYZ-100_3.jpg', buf);
    let body;
    const fakeFetch = async (u, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };
    await transferImages({
      paths: [filePath],
      options: { uploadUrl: 'http://test/up', fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });
    assert.equal(body.sku, 'XYZ-100');
    assert.equal(body.fileName, 'XYZ-100_3.jpg');
  });

  it('throws ConfigError when no uploadUrl and not mock', async () => {
    const { filePath } = makeImage('a.jpg', Buffer.from([0xFF, 0xD8, 0xFF]));
    await assert.rejects(
      () => transferImages({
        paths: [filePath],
        options: { uploadUrl: '', mockUpload: false },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
        },
      }),
      /upload url required/i
    );
  });

  it('throws when path not found', async () => {
    await assert.rejects(
      () => transferImages({
        paths: ['/nonexistent/a.jpg'],
        options: { uploadUrl: 'http://test/up' },
        deps: {
          loadEnvFile: () => {},
          pathExists: (p) => fs.existsSync(p),
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
        },
      }),
      /path not found/i
    );
  });

  it('respects uploadConcurrency limit', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const files = Array.from({ length: 4 }, (_, i) => makeImage(`f${i}.jpg`, buf));
    let concurrent = 0;
    let maxConcurrent = 0;
    const releases = [];
    const fakeFetch = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const d = deferred();
      releases.push(d.resolve);
      try {
        return await d.promise.then(() => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) }));
      } finally {
        concurrent--;
      }
    };
    const reportP = transferImages({
      paths: files.map((f) => f.filePath),
      options: { uploadUrl: 'http://test/up', uploadConcurrency: 2, fetchImpl: fakeFetch },
      deps: {
        loadEnvFile: () => {},
        pathExists: () => true,
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });
    // Drain pending deferreds one at a time so workers stay at the concurrency limit
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
      const pending = releases.splice(0, releases.length);
      for (const r of pending) r();
    }
    const report = await reportP;
    assert.equal(report.total, 4);
    assert.equal(report.success, 4);
    assert.ok(maxConcurrent <= 2, `maxConcurrent was ${maxConcurrent}`);
  });
});

describe('transferImages streaming', () => {
  it('does not preload all buffers before first fetch', async () => {
    // 5 items, mock fetch delayed 50ms, concurrency=2
    // streaming → readFile calls interleave with fetchStart (≤ 2-3 reads before first fetchStart)
    // eager → all 5 readFile calls happen before first fetchStart
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'));
    const files = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    const log = [];
    const trackingReadFile = (p) => {
      log.push({ event: 'readFile', file: path.basename(p) });
      return fs.readFileSync(p);
    };
    const trackingFetch = async (url, init) => {
      log.push({ event: 'fetchStart', file: JSON.parse(init.body).fileName });
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', uploadConcurrency: 2, fetchImpl: trackingFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: trackingReadFile,
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),       // isolate from state in this test
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.equal(report.success, 5);

      const firstFetchIdx = log.findIndex((e) => e.event === 'fetchStart');
      const readsBeforeFirstFetch = log.slice(0, firstFetchIdx).filter((e) => e.event === 'readFile').length;
      // concurrency=2, allow +1 tolerance for microtask ordering
      assert.ok(
        readsBeforeFirstFetch <= 3,
        `expected streaming (≤3 reads before first fetch), got ${readsBeforeFirstFetch}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transferImages with mockUpload', () => {
  it('uses mock upload server when --mock-upload', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-'));
    const filePath = path.join(dir, 'Z_9.jpg');
    fs.writeFileSync(filePath, buf);

    const report = await transferImages({
      paths: [filePath],
      options: { mockUpload: true, uploadConcurrency: 1, uploadRetries: 0 },
      deps: {
        loadEnvFile: () => {},
        pathExists: (p) => fs.existsSync(p),
        readFile: (p) => fs.readFileSync(p),
        startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      },
    });

    assert.equal(report.success, 1);
    assert.equal(report.results[0].ok, true);
    assert.ok(typeof report.results[0].response.id === 'number');
  });
});

describe('transferImages default deps', () => {
  const os = require('os');

  function makeImage(filename, buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-default-'));
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
  }

  it('reads upload url from CRAWLER_IMAGE_UPLOAD_URL when no uploadUrl option', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const { filePath } = makeImage('X_1.jpg', buf);

    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 7 } }) };
    };

    const prevEnv = process.env.CRAWLER_IMAGE_UPLOAD_URL;
    const prevFile = process.env.__TRANSFER_TEST_CWD;
    process.env.CRAWLER_IMAGE_UPLOAD_URL = 'http://from-env.test/up';
    process.env.__TRANSFER_TEST_CWD = '/__nonexistent__';
    try {
      const report = await transferImages({
        paths: [filePath],
        options: { fetchImpl: fakeFetch },
      });
      assert.equal(report.success, 1);
      assert.equal(captured.url, 'http://from-env.test/up');
    } finally {
      if (prevEnv === undefined) delete process.env.CRAWLER_IMAGE_UPLOAD_URL;
      else process.env.CRAWLER_IMAGE_UPLOAD_URL = prevEnv;
      if (prevFile === undefined) delete process.env.__TRANSFER_TEST_CWD;
      else process.env.__TRANSFER_TEST_CWD = prevFile;
    }
  });
});

describe('scanImages', () => {
  const os = require('os');

  function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    // Top-level images
    fs.writeFileSync(path.join(root, 'a.jpg'), Buffer.from([0xFF, 0xD8, 0xFF]));
    fs.writeFileSync(path.join(root, 'b.PNG'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    fs.writeFileSync(path.join(root, 'ignore.txt'), 'not an image');
    // Nested
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'c.webp'), Buffer.alloc(12));
    const deeper = path.join(sub, 'deeper');
    fs.mkdirSync(deeper);
    fs.writeFileSync(path.join(deeper, 'd.jpeg'), Buffer.from([0xFF, 0xD8, 0xFF]));
    return root;
  }

  it('returns only top-level image files when recursive=false', async () => {
    const { scanImages } = require('../bin/transfer-images');
    const root = makeTree();
    try {
      const result = await scanImages(root, false);
      assert.equal(result.length, 2);
      assert.ok(result.every((p) => path.dirname(p) === root));
      // Sorted
      assert.ok(result[0] < result[1]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks subdirectories when recursive=true', async () => {
    const { scanImages } = require('../bin/transfer-images');
    const root = makeTree();
    try {
      const result = await scanImages(root, true);
      assert.equal(result.length, 4);
      const fileNames = result.map((p) => path.basename(p)).sort();
      assert.deepEqual(fileNames, ['a.jpg', 'b.PNG', 'c.webp', 'd.jpeg']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('makeLogger', () => {
  const os = require('os');

  it('writes to stdout when not quiet', () => {
    const { makeLogger } = require('../bin/transfer-images');
    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };
    try {
      const logger = makeLogger({ quiet: false });
      logger.info('hello');
      assert.ok(logs.some((l) => l.includes('[INFO] hello')));
    } finally {
      process.stdout.write = orig;
    }
  });

  it('does not write to stdout when quiet', () => {
    const { makeLogger } = require('../bin/transfer-images');
    const logs = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };
    try {
      const logger = makeLogger({ quiet: true });
      logger.info('silent');
      assert.equal(logs.length, 0);
    } finally {
      process.stdout.write = orig;
    }
  });

  it('appends to log file when logFile provided', () => {
    const { makeLogger } = require('../bin/transfer-images');
    const logFile = path.join(os.tmpdir(), `logger-${Date.now()}.log`);
    try {
      const logger = makeLogger({ quiet: true, logFile });
      logger.info('first');
      logger.uploadStart(1, 3, 'a.jpg', 12);
      logger.uploadOk(1, 3, 'a.jpg', 'id-1');
      const content = fs.readFileSync(logFile, 'utf-8');
      assert.match(content, /\[INFO\] first/);
      assert.match(content, /\[UPLOAD\] \[1\/3\] a\.jpg \(12 KB\) \.\.\./);
      assert.match(content, /\[UPLOAD\] \[1\/3\] a\.jpg \.\.\. ok \(id=id-1\)/);
    } finally {
      fs.rmSync(logFile, { force: true });
    }
  });

  it('parseTransferArgs accepts --dir, --recursive, --log-file, --quiet', () => {
    const r = parseTransferArgs([
      '--dir=/tmp/imgs',
      '--recursive',
      '--log-file=/tmp/x.log',
      '--quiet',
    ]);
    assert.equal(r.options.dir, '/tmp/imgs');
    assert.equal(r.options.recursive, true);
    assert.equal(r.options.logFile, '/tmp/x.log');
    assert.equal(r.options.quiet, true);
  });
});

describe('loadState', () => {
  it('returns empty Map when state file does not exist', () => {
    const missing = path.join(os.tmpdir(), `state-missing-${Date.now()}-${Math.random()}.ndjson`);
    const map = loadState(missing);
    assert.equal(map.size, 0);
  });

  it('returns empty Map for empty file', () => {
    const f = path.join(os.tmpdir(), `state-empty-${Date.now()}.ndjson`);
    fs.writeFileSync(f, '');
    try {
      assert.equal(loadState(f).size, 0);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('skips malformed lines with a warning', () => {
    const f = path.join(os.tmpdir(), `state-bad-${Date.now()}.ndjson`);
    fs.writeFileSync(f, [
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' }),
      'not-json-line',
      JSON.stringify({ basename: 'b_1.jpg', sku: 'b', id: 2, ts: 't', uploadUrl: 'u' }),
      '',
    ].join('\n'));
    const warns = [];
    try {
      const map = loadState(f, { logger: { warn: (m) => warns.push(m) } });
      assert.equal(map.size, 2);
      assert.ok(map.has('a_1.jpg'));
      assert.ok(map.has('b_1.jpg'));
      assert.equal(warns.length, 1);
      assert.match(warns[0], /malformed/);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('keeps first entry on duplicate basename', () => {
    const f = path.join(os.tmpdir(), `state-dup-${Date.now()}.ndjson`);
    fs.writeFileSync(f, [
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' }),
      JSON.stringify({ basename: 'a_1.jpg', sku: 'a', id: 999, ts: 't2', uploadUrl: 'u' }),
    ].join('\n'));
    try {
      const map = loadState(f);
      assert.equal(map.size, 1);
      assert.equal(map.get('a_1.jpg').id, 1);  // first write wins
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

describe('appendState', () => {
  it('appends a JSON line + newline to state file', () => {
    const f = path.join(os.tmpdir(), `append-${Date.now()}.ndjson`);
    try {
      appendState(f, { basename: 'x_1.jpg', sku: 'x', id: 42, ts: '2026-07-01T00:00:00Z', uploadUrl: 'http://up' });
      appendState(f, { basename: 'y_1.jpg', sku: 'y', id: 43, ts: '2026-07-01T00:00:01Z', uploadUrl: 'http://up' });
      const content = fs.readFileSync(f, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { basename: 'x_1.jpg', sku: 'x', id: 42, ts: '2026-07-01T00:00:00Z', uploadUrl: 'http://up' });
      assert.deepEqual(JSON.parse(lines[1]).basename, 'y_1.jpg');
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `append-mkdir-${Date.now()}-${Math.random()}`);
    const f = path.join(dir, 'sub', 'state.ndjson');
    try {
      appendState(f, { basename: 'a.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' });
      assert.ok(fs.existsSync(f));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw when write fails (logs error instead)', () => {
    // 通过给一个无法解析的路径模拟 write 失败，比 chmod 更跨平台
    const f = '  not-a-valid-path  ';
    const errs = [];
    let threw = false;
    try {
      appendState(f, { basename: 'a.jpg', sku: 'a', id: 1, ts: 't', uploadUrl: 'u' }, { logger: { error: (m) => errs.push(m) } });
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /failed to append state/);
  });
});

describe('transferImages resume', () => {
  const os = require('os');

  it('skips basenames already in state file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    const stateFile = path.join(dir, 'state.ndjson');
    // Pre-populate state with one basename
    fs.writeFileSync(stateFile, JSON.stringify({
      basename: 'a_1.jpg', sku: 'a', id: 100, ts: 't', uploadUrl: 'http://test/up',
    }) + '\n');

    const files = [];
    for (const name of ['a_1.jpg', 'b_1.jpg']) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let fetchCalls = 0;
    const fakeFetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: fetchCalls } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      // 2 files, 1 already in state → only 1 fetch
      assert.equal(fetchCalls, 1);
      assert.equal(report.total, 2);
      assert.equal(report.success, 2);     // 1 uploaded + 1 skipped
      const skipped = report.results.find((r) => r.skipped);
      assert.ok(skipped);
      assert.equal(skipped.basename || skipped.fileName, 'a_1.jpg');
      assert.equal(skipped.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transferImages --force', () => {
  const os = require('os');

  it('re-uploads basenames already in state when --force set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
    const stateFile = path.join(dir, 'state.ndjson');
    fs.writeFileSync(stateFile, JSON.stringify({
      basename: 'a_1.jpg', sku: 'a', id: 100, ts: 't', uploadUrl: 'http://test/up',
    }) + '\n');

    const files = [];
    for (const name of ['a_1.jpg', 'b_1.jpg']) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let fetchCalls = 0;
    const fakeFetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: fetchCalls } }) };
    };

    try {
      const report = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, force: true, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: () => {},
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      // force → both files fetched
      assert.equal(fetchCalls, 2);
      assert.equal(report.success, 2);
      const skipped = report.results.find((r) => r.skipped);
      assert.equal(skipped, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transferImages --state-file override', () => {
  const os = require('os');

  it('uses --state-file instead of defaultStatePath', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-'));
    const customState = path.join(workDir, 'custom.ndjson');

    const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-imgs-'));
    const p = path.join(imgDir, 'x_1.jpg');
    fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

    const fakeFetch = async () => ({
      ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }),
    });

    try {
      const report = await transferImages({
        paths: [p],
        options: { uploadUrl: 'http://test/up', stateFile: customState, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: require('../bin/transfer-images').loadState,
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => { throw new Error('defaultStatePath should NOT be called when --state-file set'); },
        },
      });
      assert.equal(report.success, 1);
      assert.ok(fs.existsSync(customState), 'state file should be created at --state-file path');
      const content = fs.readFileSync(customState, 'utf-8');
      assert.match(content, /"basename":"x_1.jpg"/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(imgDir, { recursive: true, force: true });
    }
  });
});

describe('transferImages appendState on success', () => {
  const os = require('os');

  it('writes one NDJSON line per successful upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-success-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const files = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    let idCounter = 0;
    const fakeFetch = async () => {
      // Capture id per-call so concurrent fetches don't race on shared counter
      const id = ++idCounter * 100;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id } }) };
    };

    try {
      await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.ok(fs.existsSync(stateFile));
      const lines = fs.readFileSync(stateFile, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      const entries = lines.map((l) => JSON.parse(l));
      assert.deepEqual(entries.map((e) => e.id), [100, 200, 300]);
      assert.ok(entries.every((e) => e.uploadUrl === 'http://test/up'));
      assert.ok(entries.every((e) => typeof e.ts === 'string' && e.ts.length > 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transferImages no state write on failure', () => {
  const os = require('os');

  it('does not append state when upload fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-no-state-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const okPath = path.join(dir, 'ok_1.jpg');
    const failPath = path.join(dir, 'fail_1.jpg');
    fs.writeFileSync(okPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
    fs.writeFileSync(failPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

    let n = 0;
    const fakeFetch = async () => {
      n++;
      if (n === 1) return { ok: false, status: 500, text: async () => 'server error' };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1 } }) };
    };

    try {
      const report = await transferImages({
        paths: [failPath, okPath],
        options: { uploadUrl: 'http://test/up', stateFile, uploadRetries: 0, fetchImpl: fakeFetch },
        deps: {
          loadEnvFile: () => {},
          pathExists: () => true,
          readFile: (p) => fs.readFileSync(p),
          startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
          loadState: () => new Map(),
          appendState: require('../bin/transfer-images').appendState,
          defaultStatePath: () => '/tmp/should-not-be-used',
        },
      });
      assert.equal(report.success, 1);
      assert.equal(report.failed, 1);

      const lines = fs.readFileSync(stateFile, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 1, 'only the successful upload should write state');
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.basename, 'ok_1.jpg');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transferImages cross-run resume', () => {
  const os = require('os');

  it('second run with same stateFile skips already-uploaded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-run-'));
    const stateFile = path.join(dir, 'state.ndjson');

    const files = [];
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, `img${i}_1.jpg`);
      fs.writeFileSync(p, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      files.push(p);
    }

    const makeFetch = () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: calls } }) };
      };
      return { fetchImpl, getCalls: () => calls };
    };

    const deps = {
      loadEnvFile: () => {},
      pathExists: () => true,
      readFile: (p) => fs.readFileSync(p),
      startMockUploadServer: require('../src/mock-upload-server').startMockUploadServer,
      loadState: require('../bin/transfer-images').loadState,
      appendState: require('../bin/transfer-images').appendState,
      defaultStatePath: () => '/tmp/should-not-be-used',
    };

    try {
      // First run: 4 fetches
      const f1 = makeFetch();
      const r1 = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: f1.fetchImpl },
        deps,
      });
      assert.equal(f1.getCalls(), 4);
      assert.equal(r1.success, 4);

      // Second run: same stateFile → 0 fetches (all skipped via state)
      const f2 = makeFetch();
      const r2 = await transferImages({
        paths: files,
        options: { uploadUrl: 'http://test/up', stateFile, fetchImpl: f2.fetchImpl },
        deps,
      });
      assert.equal(f2.getCalls(), 0, 'second run should skip all already-uploaded basenames');
      assert.equal(r2.total, 4);
      assert.equal(r2.success, 4);
      assert.ok(r2.results.every((r) => r.skipped === true));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultStatePath', () => {
  it('returns same hash for same dir + same cwd', () => {
    const dir = '/tmp/test-dir-A';
    const prevCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const a = defaultStatePath(dir);
      const b = defaultStatePath(dir);
      assert.equal(a, b);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('returns different hash for different dirs', () => {
    const prevCwd = process.cwd();
    process.chdir('/tmp');
    try {
      const a = defaultStatePath('/tmp/test-dir-A');
      const b = defaultStatePath('/tmp/test-dir-B');
      assert.notEqual(a, b);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('places file under .transfer-state/ in cwd', () => {
    const prevCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statepath-'));
    process.chdir(tmpDir);
    try {
      const p = defaultStatePath(path.join(tmpDir, 'some', 'dir'));
      const sep = path.sep.replace(/\\/g, '\\\\');
      assert.match(p, new RegExp(`\\.transfer-state${sep}[a-f0-9]{12}\\.ndjson$`));
      assert.ok(p.startsWith(path.join(tmpDir, '.transfer-state') + path.sep));
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});