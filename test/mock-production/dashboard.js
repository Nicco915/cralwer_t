const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { MockProductionServer } = require('./mock-server');

const execAsync = promisify(exec);

// Pin PM2_HOME to a project-local directory so the PM2 daemon and its logs/
// named pipes are created in a writable location on Windows, instead of trying
// to use a system directory like C:\ProgramData\pm2.
const DEFAULT_PM2_HOME = path.join(process.cwd(), '.pm2');
if (!process.env.PM2_HOME) {
  process.env.PM2_HOME = DEFAULT_PM2_HOME;
}
try {
  fs.mkdirSync(process.env.PM2_HOME, { recursive: true });
} catch (e) {
  // Best-effort; PM2 will report its own error if it cannot write here.
}

function formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
  if (!boundaryMatch) return null;
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts = [];

  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    // Skip trailing CRLF after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    // End boundary
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;

    const nextBoundary = buffer.indexOf(boundary, start);
    if (nextBoundary === -1) break;

    let partEnd = nextBoundary;
    // Strip trailing CRLF before next boundary
    if (partEnd > start && buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }

    const partBuffer = buffer.slice(start, partEnd);
    const headerEnd = partBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      start = nextBoundary;
      continue;
    }

    const header = partBuffer.slice(0, headerEnd).toString('utf8');
    const body = partBuffer.slice(headerEnd + 4);

    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]*)"/);
    const ctMatch = header.match(/Content-Type:\s*([^\r\n]+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : null,
      data: body,
    });

    start = nextBoundary;
  }

  return parts;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSONbig.stringify(data));
}

function errorResponse(res, message, status = 500) {
  jsonResponse(res, { code: status, error: message }, status);
}

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port !== undefined ? options.port : 8080;
    this.host = options.host || '127.0.0.1';
    this.mockPort = options.mockPort || 0;
    this.mockHost = options.mockHost || '127.0.0.1';
    this.mockOptions = options.mockOptions || {};

    this.mockServer = null;
    this.mockInfo = null;
    this.sseClients = new Set();
    this.maxCallbacks = options.maxCallbacks || 500;
    this.recentCallbacks = [];
    this.pm2AppName = options.pm2AppName || 'crawler-dashboard-test';
    // Use a project-local PM2 home so the PM2 daemon/logs are writable on Windows
    // without requiring elevated permissions for C:\ProgramData\pm2.
    this.pm2Home = options.pm2Home || path.join(process.cwd(), '.pm2');
    // Allow tests and callers to inject a custom exec implementation (cross-platform stubbing).
    this.execAsync = options.execAsync || execAsync;
    this.server = null;
    this.connections = new Set();
  }

  ensurePm2Home() {
    try {
      fs.mkdirSync(this.pm2Home, { recursive: true });
    } catch (e) {
      // Best-effort: if the directory cannot be created, PM2 will report its own error.
    }
  }

  pm2Env(extraEnv = {}) {
    return {
      ...process.env,
      PM2_HOME: this.pm2Home,
      ...extraEnv,
    };
  }

  async startUpstream() {
    if (this.mockServer && this.mockInfo) {
      return { success: true, url: this.mockInfo.url, alreadyRunning: true };
    }

    this.mockServer = new MockProductionServer({
      port: this.mockPort,
      host: this.mockHost,
      autoLoad: false,
      ...this.mockOptions,
      onCallback: (callback, response) => {
        this.broadcastCallback(callback, response);
      },
    });

    this.mockInfo = await this.mockServer.start();
    return { success: true, url: this.mockInfo.url };
  }

  async stopUpstream() {
    if (!this.mockServer) {
      return { success: true, alreadyStopped: true };
    }
    await this.mockServer.close();
    this.mockServer = null;
    this.mockInfo = null;
    return { success: true };
  }

  getMockBaseUrl() {
    return this.mockInfo ? this.mockInfo.url : null;
  }

  async loadSkusFromExcel(buffer) {
    // Lazy-load ExcelJS because it is heavy and only needed for uploads.
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    const skus = [];
    const skuColumn = this.mockOptions.skuColumn || 1;
    const headerRow = this.mockOptions.headerRow || 1;
    const dataRowStart = this.mockOptions.dataRowStart || headerRow + 1;

    for (let rowNumber = dataRowStart; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const cellValue = row.getCell(skuColumn).value;
      if (cellValue) {
        const sku = typeof cellValue === 'object' ? (cellValue.text || cellValue.result) : String(cellValue).trim();
        if (sku) skus.push(sku);
      }
    }
    return skus;
  }

  async setTasksFromExcel(buffer) {
    if (!this.mockServer) {
      throw new Error('Upstream mock server is not running');
    }
    const skus = await this.loadSkusFromExcel(buffer);
    this.mockServer.setTasks(skus);
    return { success: true, count: skus.length };
  }

  addTasks(skus) {
    if (!this.mockServer) {
      throw new Error('Upstream mock server is not running');
    }
    const added = this.mockServer.addTasks(skus);
    return { success: true, count: added.length };
  }

  getTaskList() {
    if (!this.mockServer) return [];
    return this.mockServer.tasks.map(task => ({
      ...task,
      status: this.mockServer.completedTaskIds.has(task.id)
        ? 'completed'
        : this.mockServer.issuedTaskIds.has(task.id)
          ? 'issued'
          : 'pending',
    }));
  }

  broadcastCallback(callback, response) {
    const record = {
      time: formatTimestamp(),
      callback,
      response,
    };
    this.recentCallbacks.unshift(record);
    if (this.recentCallbacks.length > this.maxCallbacks) {
      this.recentCallbacks.pop();
    }

    const payload = JSONbig.stringify(record);
    const message = `data: ${payload}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch (e) {
        // Client disconnected; will be cleaned up on next heartbeat.
      }
    }
  }

  async startCrawler() {
    if (!this.mockInfo) {
      throw new Error('Upstream mock server is not running');
    }

    const taskUrl = `${this.mockInfo.url}/renren-api/classify/open/crawler/tasks`;
    const callbackUrl = `${this.mockInfo.url}/renren-api/classify/open/crawler/callback`;

    // On Windows a stale PM2 daemon from a different user/context can hold the
    // named pipe and cause EPERM. Try to kill any existing daemon first.
    try {
      await this.execAsync('pm2 kill', {
        timeout: 5000,
        env: this.pm2Env(),
      });
    } catch (e) {
      // ignore: if the daemon is owned by another user we cannot kill it here.
    }

    try {
      // Stop existing crawler if any; ignore errors when it does not exist.
      await this.execAsync(`pm2 stop ${this.pm2AppName}`, {
        timeout: 5000,
        env: this.pm2Env(),
      });
    } catch (e) {
      // ignore cleanup errors
    }
    try {
      await this.execAsync(`pm2 delete ${this.pm2AppName}`, {
        timeout: 5000,
        env: this.pm2Env(),
      });
    } catch (e) {
      // ignore cleanup errors
    }

    const env = {
      CRAWLER_MODE: 'service',
      CRAWLER_NODE_CODE: 'crawler-dashboard-test',
      CRAWLER_NODE_TOKEN: 'test-token',
      CRAWLER_TASK_URL: taskUrl,
      CRAWLER_CALLBACK_URL: callbackUrl,
      CRAWLER_CHANNELS: '1',
      CRAWLER_POLL_INTERVAL: '5000',
      CRAWLER_POLL_LIMIT: '10',
      CRAWLER_HEADLESS: 'true',
    };

    // Pass environment variables through exec options so this works on both
    // Unix shells and Windows cmd/PowerShell. Inline syntax like KEY=val pm2 ...
    // is not valid on Windows.
    this.ensurePm2Home();
    const cmd = `pm2 start ./bin/run.js --name ${this.pm2AppName}`;
    try {
      const { stderr } = await this.execAsync(cmd, {
        cwd: process.cwd(),
        env: this.pm2Env(env),
        timeout: 10000,
      });
      if (stderr && !stderr.includes('[PM2]')) {
        console.error('[DASHBOARD] PM2 start stderr:', stderr);
      }
    } catch (e) {
      const msg = e.message || '';
      const isPermError = msg.includes('EPERM') || msg.includes('rpc.sock') || msg.toLowerCase().includes('permission');
      if (isPermError) {
        throw new Error(
          `PM2 daemon permission error: ${msg}. ` +
          `Current PM2_HOME is ${this.pm2Home}. ` +
          'If another PM2 daemon is already running under a different Windows user or as Administrator, ' +
          'please run "pm2 kill" in an elevated PowerShell and then restart this dashboard.'
        );
      }
      throw e;
    }

    return { success: true, taskUrl, callbackUrl };
  }

  async stopCrawler() {
    try {
      await this.execAsync(`pm2 stop ${this.pm2AppName}`, {
        timeout: 5000,
        env: this.pm2Env(),
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getCrawlerStatus() {
    try {
      const { stdout } = await this.execAsync('pm2 jlist --json', {
        timeout: 3000,
        env: this.pm2Env(),
      });
      const list = JSON.parse(stdout || '[]');
      const app = list.find(p => p.name === this.pm2AppName);
      if (!app) return { running: false, status: 'not found' };
      return {
        running: app.pm2_env.status === 'online',
        status: app.pm2_env.status,
        pid: app.pid,
        uptime: app.pm2_env.pm_uptime,
        restartTime: app.pm2_env.restart_time,
      };
    } catch (e) {
      return { running: false, status: 'error', error: e.message };
    }
  }

  async getCrawlerLogs(lines = 50) {
    try {
      const { stdout } = await this.execAsync(`pm2 logs ${this.pm2AppName} --lines ${lines} --nostream`, {
        timeout: 5000,
        env: this.pm2Env(),
      });
      return stdout || '';
    } catch (e) {
      return '';
    }
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' && req.method === 'GET') {
      this.serveDashboard(res);
      return;
    }

    if (pathname === '/api/callbacks/stream' && req.method === 'GET') {
      this.serveSSE(req, res);
      return;
    }

    if (pathname.startsWith('/api/')) {
      this.serveApi(req, res, pathname, url);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }

  serveSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    this.sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch (e) {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }

  async serveApi(req, res, pathname, url) {
    try {
      if (pathname === '/api/status' && req.method === 'GET') {
        const crawlerStatus = await this.getCrawlerStatus();
        jsonResponse(res, {
          code: 0,
          upstreamRunning: !!this.mockInfo,
          upstreamUrl: this.mockInfo ? this.mockInfo.url : null,
          crawler: crawlerStatus,
        });
        return;
      }

      if (pathname === '/api/upstream/start' && req.method === 'POST') {
        const result = await this.startUpstream();
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/upstream/stop' && req.method === 'POST') {
        await this.stopUpstream();
        jsonResponse(res, { code: 0, data: { success: true } });
        return;
      }

      if (pathname === '/api/tasks' && req.method === 'GET') {
        jsonResponse(res, { code: 0, data: this.getTaskList() });
        return;
      }

      if (pathname === '/api/tasks/upload' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        const body = await collectRequestBody(req);
        const parts = parseMultipart(body, contentType);
        if (!parts) {
          errorResponse(res, 'Invalid multipart upload', 400);
          return;
        }
        const filePart = parts.find(p => p.filename && p.data.length > 0);
        if (!filePart) {
          errorResponse(res, 'No file uploaded', 400);
          return;
        }
        const result = await this.setTasksFromExcel(filePart.data);
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/tasks/add' && req.method === 'POST') {
        const body = await collectRequestBody(req);
        const parsed = JSONbig.parse(body.toString() || '{}');
        const skus = Array.isArray(parsed.skus) ? parsed.skus : [parsed.sku];
        const result = this.addTasks(skus.filter(Boolean));
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/crawler/start' && req.method === 'POST') {
        const result = await this.startCrawler();
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/crawler/stop' && req.method === 'POST') {
        const result = await this.stopCrawler();
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/crawler/status' && req.method === 'GET') {
        const result = await this.getCrawlerStatus();
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/crawler/logs' && req.method === 'GET') {
        const lines = Number(url.searchParams.get('lines')) || 50;
        const result = await this.getCrawlerLogs(lines);
        jsonResponse(res, { code: 0, data: result });
        return;
      }

      if (pathname === '/api/callbacks' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 100;
        jsonResponse(res, { code: 0, data: this.recentCallbacks.slice(0, limit) });
        return;
      }

      if (pathname === '/api/stats' && req.method === 'GET') {
        if (!this.mockServer) {
          jsonResponse(res, { code: 0, data: null });
          return;
        }
        jsonResponse(res, { code: 0, data: this.mockServer.getStats() });
        return;
      }

      errorResponse(res, 'Not found', 404);
    } catch (e) {
      console.error('[DASHBOARD] API error:', e.message);
      errorResponse(res, e.message);
    }
  }

  serveDashboard(res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml());
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.on('close', () => this.connections.delete(socket));
      });
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address();
        this.port = address.port;
        resolve({
          port: this.port,
          host: this.host,
          url: `http://${this.host}:${this.port}`,
          close: () => this.close(),
        });
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const socket of this.connections) {
        try { socket.destroy(); } catch (e) {}
      }
      this.connections.clear();
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}

function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>模拟生产测试 Dashboard</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e5e7eb;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #16a34a;
      --danger: #dc2626;
      --warning: #d97706;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --card: #1e293b;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --border: #334155;
        --primary: #3b82f6;
        --primary-hover: #60a5fa;
        --success: #22c55e;
        --danger: #ef4444;
        --warning: #f59e0b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 24px; font-size: 28px; }
    h2 { margin: 0 0 16px; font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .row:last-child { margin-bottom: 0; }
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      background: var(--primary);
      color: white;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover { background: var(--primary-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #b91c1c; }
    input, textarea, select {
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
    }
    textarea { min-width: 240px; min-height: 80px; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .status.online { background: rgba(22, 163, 74, 0.15); color: var(--success); }
    .status.offline { background: rgba(220, 38, 38, 0.15); color: var(--danger); }
    .status.warning { background: rgba(217, 119, 6, 0.15); color: var(--warning); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .logs {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      height: 240px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .callback-item {
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
    }
    .callback-item:last-child { border-bottom: none; }
    .callback-meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .callback-body {
      background: var(--bg);
      border-radius: 6px;
      padding: 8px;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      overflow-x: auto;
      max-height: 120px;
      overflow-y: auto;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge.pending { background: rgba(217, 119, 6, 0.15); color: var(--warning); }
    .badge.issued { background: rgba(59, 130, 246, 0.15); color: var(--primary); }
    .badge.completed { background: rgba(22, 163, 74, 0.15); color: var(--success); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .stat { background: var(--bg); border-radius: 8px; padding: 12px; text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; }
    .stat-label { font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <h1>模拟生产测试 Dashboard</h1>
    <div class="grid">
      <div class="card">
        <h2>上游模拟接口</h2>
        <div class="row">
          <span id="upstreamStatus" class="status offline"><span class="dot"></span> 未启动</span>
          <span id="upstreamUrl" class="muted"></span>
        </div>
        <div class="row">
          <button id="btnStartUpstream">启动上游服务</button>
          <button id="btnStopUpstream" class="danger">停止上游服务</button>
          <button id="btnRefreshStatus">刷新状态</button>
        </div>
      </div>

      <div class="card">
        <h2>PM2 爬虫</h2>
        <div class="row">
          <span id="crawlerStatus" class="status offline"><span class="dot"></span> 未运行</span>
        </div>
        <div class="row">
          <button id="btnStartCrawler">启动爬虫（PM2）</button>
          <button id="btnStopCrawler" class="danger">停止爬虫</button>
        </div>
        <div class="row">
          <button id="btnRefreshLogs">刷新日志</button>
          <input id="logLines" type="number" value="50" min="10" max="500" style="width: 80px;">
          <span style="color: var(--muted);">行</span>
        </div>
        <div id="crawlerLogs" class="logs">点击「刷新日志」查看 PM2 日志</div>
      </div>

      <div class="card">
        <h2>任务管理</h2>
        <div class="row">
          <input id="fileInput" type="file" accept=".xlsx,.xls">
          <button id="btnUpload">上传 Excel 替换任务</button>
        </div>
        <div class="row">
          <textarea id="skuInput" placeholder="每行一个 SKU"></textarea>
          <button id="btnAddSkus">追加 SKU</button>
        </div>
        <div class="row">
          <button id="btnRefreshTasks">刷新任务列表</button>
        </div>
      </div>

      <div class="card">
        <h2>统计</h2>
        <div class="stats" id="stats">
          <div class="stat"><div class="stat-value" id="statTotal">-</div><div class="stat-label">总任务</div></div>
          <div class="stat"><div class="stat-value" id="statCompleted">-</div><div class="stat-label">已完成</div></div>
          <div class="stat"><div class="stat-value" id="statCallbacks">-</div><div class="stat-label">回调数</div></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 24px;">
      <h2>任务列表</h2>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr><th>ID</th><th>SKU</th><th>状态</th><th>商品名</th></tr>
          </thead>
          <tbody id="taskTable"><tr><td colspan="4">暂无数据</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top: 24px;">
      <h2>实时回调</h2>
      <div id="callbacks" class="logs" style="height: 400px;">等待回调...</div>
    </div>
  </div>

  <script>
    const api = async (path, options = {}) => {
      const res = await fetch(path, options);
      return res.json();
    };

    const setStatus = (id, text, type) => {
      const el = document.getElementById(id);
      el.className = 'status ' + type;
      el.innerHTML = '<span class="dot"></span> ' + text;
    };

    const refreshStatus = async () => {
      const data = await api('/api/status');
      if (data.upstreamRunning) {
        setStatus('upstreamStatus', '运行中 ' + data.upstreamUrl, 'online');
        document.getElementById('upstreamUrl').textContent = data.upstreamUrl;
      } else {
        setStatus('upstreamStatus', '未启动', 'offline');
        document.getElementById('upstreamUrl').textContent = '';
      }
      if (data.crawler.running) {
        setStatus('crawlerStatus', '运行中', 'online');
      } else if (data.crawler.status === 'not found') {
        setStatus('crawlerStatus', '未运行', 'offline');
      } else {
        setStatus('crawlerStatus', data.crawler.status || '未知', 'warning');
      }
      refreshStats();
    };

    const refreshStats = async () => {
      const data = await api('/api/stats');
      if (data.data) {
        document.getElementById('statTotal').textContent = data.data.totalTasks;
        document.getElementById('statCompleted').textContent = data.data.completedCount;
        document.getElementById('statCallbacks').textContent = data.data.callbackCount;
      }
    };

    const refreshTasks = async () => {
      const data = await api('/api/tasks');
      const tbody = document.getElementById('taskTable');
      if (!data.data || data.data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">暂无任务</td></tr>';
        return;
      }
      tbody.innerHTML = data.data.map(t => \`
        <tr>
          <td title="\${t.id}">\${t.id.slice(-12)}</td>
          <td>\${t.sku}</td>
          <td><span class="badge \${t.status}">\${t.status}</span></td>
          <td>\${t.goodsNameCn || '-'}</td>
        </tr>
      \`).join('');
    };

    const appendCallback = (record) => {
      const container = document.getElementById('callbacks');
      if (container.textContent === '等待回调...') container.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'callback-item';
      const cb = record.callback;
      const statusClass = cb.success ? 'online' : 'warning';
      div.innerHTML = \`
        <div class="callback-meta">
          <span class="status \${statusClass}"><span class="dot"></span> \${cb.success ? 'success' : 'fail'}</span>
          \${record.time} | SKU: \${cb.sku} | 下游返回: \${record.response.status}
        </div>
        <div class="callback-body">\${JSON.stringify(cb, null, 2)}</div>
      \`;
      container.prepend(div);
      while (container.children.length > 50) {
        container.removeChild(container.lastChild);
      }
    };

    const setupSSE = () => {
      const es = new EventSource('/api/callbacks/stream');
      es.onmessage = (e) => {
        try {
          const record = JSON.parse(e.data);
          appendCallback(record);
          refreshStats();
          refreshTasks();
        } catch (err) {}
      };
      es.onerror = () => {
        console.log('SSE reconnecting...');
      };
    };

    document.getElementById('btnStartUpstream').onclick = async () => {
      await api('/api/upstream/start', { method: 'POST' });
      await refreshStatus();
    };
    document.getElementById('btnStopUpstream').onclick = async () => {
      await api('/api/upstream/stop', { method: 'POST' });
      await refreshStatus();
    };
    document.getElementById('btnStartCrawler').onclick = async () => {
      await api('/api/crawler/start', { method: 'POST' });
      await refreshStatus();
    };
    document.getElementById('btnStopCrawler').onclick = async () => {
      await api('/api/crawler/stop', { method: 'POST' });
      await refreshStatus();
    };
    document.getElementById('btnRefreshStatus').onclick = refreshStatus;
    document.getElementById('btnRefreshTasks').onclick = refreshTasks;
    document.getElementById('btnRefreshLogs').onclick = async () => {
      const lines = document.getElementById('logLines').value;
      const data = await api(\`/api/crawler/logs?lines=\${lines}\`);
      document.getElementById('crawlerLogs').textContent = data.data || '无日志';
    };
    document.getElementById('btnUpload').onclick = async () => {
      const file = document.getElementById('fileInput').files[0];
      if (!file) return alert('请选择 Excel 文件');
      const form = new FormData();
      form.append('file', file);
      await fetch('/api/tasks/upload', { method: 'POST', body: form });
      await refreshTasks();
      await refreshStats();
    };
    document.getElementById('btnAddSkus').onclick = async () => {
      const text = document.getElementById('skuInput').value.trim();
      if (!text) return;
      const skus = text.split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
      await api('/api/tasks/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus }),
      });
      document.getElementById('skuInput').value = '';
      await refreshTasks();
      await refreshStats();
    };

    setupSSE();
    refreshStatus();
    refreshTasks();
  </script>
</body>
</html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { port: 8080, host: '127.0.0.1', mockPort: 0 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--mock-port' && i + 1 < args.length) {
      options.mockPort = Number(args[i + 1]);
      i++;
    }
  }

  const dashboard = new DashboardServer(options);
  const info = await dashboard.start();
  console.log(`[DASHBOARD] Dashboard running at ${info.url}`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { DashboardServer };
