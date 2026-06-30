const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseTransferArgs,
  transferImages,
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
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 9, sku: 'A_1' } }) };
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
    assert.equal(report.results[0].sku, 'A_1');
    assert.equal(report.results[0].fileName, 'A_1.jpg');
    assert.equal(captured.url, 'http://test/up');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.sku, 'A_1');
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

  it('infers SKU from fileName without extension', async () => {
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
    assert.equal(body.sku, 'XYZ-100_3');
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