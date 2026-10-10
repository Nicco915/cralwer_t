const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { cleanupDiagnostics } = require('../src/page-crawler');

describe('cleanupDiagnostics', () => {
  function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'diag-cleanup-test-'));
  }

  function daysAgo(n) {
    const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function makeOldDir(parent, name) {
    const dir = path.join(parent, name || daysAgo(30));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    // cleanupDiagnostics 要求 mtime 与目录名日期都过期才删除
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, longAgo, longAgo);
    return dir;
  }

  it('deletes expired date dirs and keeps recent ones (no nodeCode layer)', () => {
    const root = makeRoot();
    const oldDir = makeOldDir(root);
    const recentDir = path.join(root, daysAgo(1));
    fs.mkdirSync(recentDir);
    fs.writeFileSync(path.join(recentDir, 'b.json'), '{}');

    cleanupDiagnostics(root, 7);

    assert.ok(!fs.existsSync(oldDir), 'expired date dir should be deleted');
    assert.ok(fs.existsSync(recentDir), 'recent date dir should be kept');
  });

  it('deletes expired date dirs under a nodeCode intermediate layer', () => {
    const root = makeRoot();
    const nodeDir = path.join(root, 'node-ca-01');
    const oldDir = makeOldDir(nodeDir);
    const recentDir = path.join(nodeDir, daysAgo(1));
    fs.mkdirSync(recentDir, { recursive: true });

    cleanupDiagnostics(root, 7);

    assert.ok(!fs.existsSync(oldDir), 'expired date dir under nodeCode should be deleted');
    assert.ok(fs.existsSync(recentDir), 'recent date dir under nodeCode should be kept');
    assert.ok(fs.existsSync(nodeDir), 'nodeCode layer itself should be kept');
  });

  it('retentionDays=0 disables cleanup', () => {
    const root = makeRoot();
    const oldDir = makeOldDir(root);

    cleanupDiagnostics(root, 0);

    assert.ok(fs.existsSync(oldDir));
  });

  it('ignores non-date directory names and non-directory entries', () => {
    const root = makeRoot();
    const otherDir = path.join(root, 'not-a-date');
    fs.mkdirSync(otherDir);
    // 非日期目录被视为可能的 nodeCode 层，其子目录非日期也不删
    const nested = path.join(otherDir, 'still-not-a-date');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');

    assert.doesNotThrow(() => cleanupDiagnostics(root, 7));
    assert.ok(fs.existsSync(otherDir));
    assert.ok(fs.existsSync(nested));
    assert.ok(fs.existsSync(path.join(root, 'stray.txt')));
  });

  it('keeps expired-name dir when mtime is fresh (double-check against misdelete)', () => {
    const root = makeRoot();
    const dir = path.join(root, daysAgo(30));
    fs.mkdirSync(dir);
    // mtime 是“现在”（刚创建），名称虽过期也不删
    cleanupDiagnostics(root, 7);
    assert.ok(fs.existsSync(dir), 'dir with fresh mtime should be kept even if name date is old');
  });

  it('handles missing diagnostic root gracefully', () => {
    assert.doesNotThrow(() => cleanupDiagnostics(path.join(os.tmpdir(), 'diag-cleanup-nonexistent-xyz'), 7));
    assert.doesNotThrow(() => cleanupDiagnostics('', 7));
  });
});
