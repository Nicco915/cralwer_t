#!/usr/bin/env node
/**
 * 批量端到端测试包装器
 * 用法:
 *   node scripts/batch-test.js <count> <phase-label> [offset]
 *
 * - 从 mock_test/mocktest.xlsx 读 SKU 列表
 * - 每次 spawn node test-sku.js <sku> --mock-upload
 * - 跑完后 curl ipinfo.io 校验出口 IP
 * - 把每条结果写入 test/batch-runs/<phase>-<ts>.jsonl
 * - 跑完输出汇总到 test/batch-runs/<phase>-<ts>.json
 *
 * 注意: 不会打印 .env 中的代理密码。
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function log(...args) { console.log(...args); }

function redact(text) {
  if (!text) return text;
  // 脱敏 .env 中的代理凭据
  return String(text).replace(/(CLIPROXY_PASSWORD|KUAIDAILI_SECRET_KEY|KUAIDAILI_SECRET_ID)="?[^"\s]+"?/g, '$1=***');
}

function parseResultJson(stdout) {
  // test-sku.js 在 === Result === 后输出 JSON 块
  const marker = '=== Result ===';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return null;
  const tail = stdout.slice(idx + marker.length).trim();
  // 取首个 {...} 顶层 JSON
  const firstBrace = tail.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = firstBrace; i < tail.length; i++) {
    const c = tail[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(tail.slice(firstBrace, end + 1)); }
  catch { return null; }
}

function fetchIpInfo() {
  try {
    const raw = execSync('curl -sS --max-time 10 https://ipinfo.io/json', { encoding: 'utf-8' });
    return JSON.parse(raw);
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function runOne(sku, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn('node', ['test-sku.js', sku, '--mock-upload'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 当设置了 CLASH_PROXY 时，浏览器进程级代理指向 Clash，
    // 让浏览器内部访问 Cliproxy 的 CONNECT 也先经 Clash 出大陆。

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      log(`  [TIMEOUT] killing after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const parsed = parseResultJson(stdout) || {};
      resolve({
        elapsed,
        exitCode: code,
        signal,
        result: parsed,
        stdoutTail: stdout.slice(-600),
        stderrTail: stderr.slice(-400),
      });
    });
  });
}

async function loadSkus() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('mock_test/mocktest.xlsx');
  const ws = wb.worksheets[0];
  const skus = [];
  ws.eachRow({ includeEmpty: false }, (row, idx) => {
    if (idx === 1) return; // skip header
    const v = row.getCell(1).value;
    if (v) skus.push(String(v).trim());
  });
  return skus;
}

async function main() {
  const count = Number(process.argv[2] || 5);
  const phase = process.argv[3] || `phase-${Date.now()}`;
  const offset = Number(process.argv[4] || 0);
  const perTimeout = Number(process.env.BATCH_PER_TIMEOUT_MS || 180000); // 3 min / SKU

  log(`[BATCH] phase=${phase} count=${count} offset=${offset} perTimeout=${perTimeout}ms`);

  const allSkus = await loadSkus();
  const selected = allSkus.slice(offset, offset + count);
  log(`[BATCH] selected SKUs from xlsx: ${selected.length}`);
  log(`[BATCH] first: ${selected[0]} ... last: ${selected[selected.length - 1]}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve('test/batch-runs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${phase}-${ts}.jsonl`);
  const summaryFile = path.join(dir, `${phase}-${ts}.json`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const ipSet = new Set();
  const ipInfos = [];
  const results = [];
  let success = 0, fail = 0;

  for (let i = 0; i < selected.length; i++) {
    const sku = selected[i];
    log(`\n[${i + 1}/${selected.length}] SKU: ${sku}`);
    const r = await runOne(sku, perTimeout);

    log(`  exit=${r.exitCode} signal=${r.signal} time=${r.elapsed}s`);
    log(`  status=${r.result.status || '?'} product=${r.result.product_name || ''} images=${r.result.image_count ?? '?'} error=${r.result.error || ''}`);

    if (r.result.error) {
      log(`  error_tail: ${redact(r.stderrTail || r.stdoutTail).slice(-300)}`);
    }

    const ipInfo = fetchIpInfo();
    if (ipInfo && ipInfo.ip) {
      ipSet.add(ipInfo.ip);
      ipInfos.push({ ip: ipInfo.ip, country: ipInfo.country, org: ipInfo.org });
      log(`  ip=${ipInfo.ip} country=${ipInfo.country} org=${ipInfo.org}`);
    } else {
      log(`  ip_check_failed: ${ipInfo.error || 'unknown'}`);
      ipInfos.push({ error: ipInfo.error || 'unknown' });
    }

    const line = {
      iter: i + 1,
      sku,
      elapsed: r.elapsed,
      exitCode: r.exitCode,
      signal: r.signal,
      status: r.result.status || 'unknown',
      product_name: r.result.product_name || '',
      product_url: r.result.product_url || '',
      image_count: r.result.image_count ?? null,
      error: r.result.error || null,
      ip: ipInfo.ip || null,
      country: ipInfo.country || null,
      org: ipInfo.org || null,
    };
    results.push(line);
    logStream.write(JSON.stringify(line) + '\n');

    if (line.status === 'success') success++; else fail++;

    // 避免 ipinfo 速率限制
    if (i < selected.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  logStream.end();
  const summary = {
    phase,
    total: selected.length,
    success,
    fail,
    successRate: ((success / selected.length) * 100).toFixed(1) + '%',
    uniqueIps: Array.from(ipSet),
    ipInfos,
    startedAt: ts,
    finishedAt: new Date().toISOString().replace(/[:.]/g, '-'),
    results,
  };
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  log(`\n=== Summary [${phase}] ===`);
  log(`Total: ${selected.length}  Success: ${success}  Fail: ${fail}  Rate: ${summary.successRate}`);
  log(`Unique IPs: ${summary.uniqueIps.length}  -> ${summary.uniqueIps.join(', ') || '(none)'}`);
  log(`Log:    ${logFile}`);
  log(`Report: ${summaryFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });