const http = require('http');
const path = require('path');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });

const DEFAULT_TASK_ID_OFFSET = 2070310839000000000n;
const DEFAULT_IMPORT_TASK_ID_OFFSET = 2070310823000000000n;
const DEFAULT_GOODS_ITEM_ID_OFFSET = 2070310837000000000n;
const DEFAULT_NODE_ID = '2000000000000000004';
const DEFAULT_CREATOR = '1067246875800000001';
const DEFAULT_UPDATER = '1067246875800000001';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function offsetTimestamp(base, secondsDelta) {
  const d = new Date(base.getTime() + secondsDelta * 1000);
  return formatTimestamp(d);
}

class MockProductionServer {
  constructor(options = {}) {
    this.port = options.port || 0;
    this.host = options.host || '127.0.0.1';
    this.excelPath = options.excelPath !== undefined
      ? options.excelPath
      : path.resolve(__dirname, '../../mock_test/mocktest.xlsx');
    this.autoLoad = options.autoLoad !== false;
    this.sheetName = options.sheetName || null;
    this.skuColumn = options.skuColumn || 1;
    this.headerRow = options.headerRow || 1;
    this.dataRowStart = options.dataRowStart || this.headerRow + 1;
    this.nodeCode = options.nodeCode || null;
    this.maxTasks = options.maxTasks || null;
    this.failureRate = Math.min(1, Math.max(0, options.failureRate || 0));
    this.onCallback = options.onCallback || null;
    this.taskIdOffset = options.taskIdOffset || DEFAULT_TASK_ID_OFFSET;
    this.importTaskIdOffset = options.importTaskIdOffset || DEFAULT_IMPORT_TASK_ID_OFFSET;
    this.goodsItemIdOffset = options.goodsItemIdOffset || DEFAULT_GOODS_ITEM_ID_OFFSET;
    this.nodeId = options.nodeId || DEFAULT_NODE_ID;
    this.creator = options.creator || DEFAULT_CREATOR;
    this.updater = options.updater || DEFAULT_UPDATER;

    this.skus = [];
    this.tasks = [];
    this.completedTaskIds = new Set();
    this.issuedTaskIds = new Set();
    this.callbacks = [];
    this.callbackIds = new Set();
    this.duplicateCallbacks = 0;
    this.successCallbacks = 0;
    this.failedCallbacks = 0;
    this.server = null;
    this.connections = new Set();
    this.startTime = new Date();
  }

  async loadSkus() {
    // Lazy-load ExcelJS because it is heavy and only needed when reading Excel.
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(this.excelPath);
    const worksheet = this.sheetName
      ? workbook.getWorksheet(this.sheetName)
      : workbook.worksheets[0];

    if (!worksheet) {
      throw new Error(`Worksheet ${this.sheetName || 'first sheet'} not found in ${this.excelPath}`);
    }

    const skus = [];
    for (let rowNumber = this.dataRowStart; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const cellValue = row.getCell(this.skuColumn).value;
      if (cellValue) {
        const sku = typeof cellValue === 'object' ? (cellValue.text || cellValue.result) : String(cellValue).trim();
        if (sku) {
          skus.push(sku);
        }
      }
    }

    const limitedSkus = this.maxTasks ? skus.slice(0, this.maxTasks) : skus;
    this.skus = limitedSkus;
    this.tasks = this.buildTasks(limitedSkus);
    return this.skus;
  }

  buildTasks(skus) {
    const now = new Date();
    return skus.map((sku, index) => {
      const id = BigInt(this.taskIdOffset) + BigInt(index);
      const importTaskId = BigInt(this.importTaskIdOffset) + BigInt(index);
      const goodsItemId = BigInt(this.goodsItemIdOffset) + BigInt(index);
      const createDate = formatTimestamp(now);
      const assignTime = createDate;
      const updateDate = createDate;
      const startTime = offsetTimestamp(now, index);

      return {
        assignTime,
        createDate,
        creator: this.creator,
        errorMessage: null,
        finishTime: null,
        goodsItemId: String(goodsItemId),
        goodsNameCn: String(index + 1),
        goodsNameEn: null,
        id: String(id),
        importTaskId: String(importTaskId),
        nodeCode: this.nodeCode || 'crawler-04',
        nodeId: this.nodeId,
        retryCount: 0,
        sku,
        startTime,
        status: 'CRAWLING',
        updateDate,
        updater: this.updater,
      };
    });
  }

  setTasks(skus) {
    this.skus = skus.slice();
    this.tasks = this.buildTasks(this.skus);
    this.completedTaskIds.clear();
    this.issuedTaskIds.clear();
    this.callbacks = [];
    this.callbackIds.clear();
    this.duplicateCallbacks = 0;
    this.successCallbacks = 0;
    this.failedCallbacks = 0;
    return this.tasks;
  }

  addTasks(skus) {
    const newSkus = Array.isArray(skus) ? skus : [skus];
    const startIndex = this.skus.length;
    this.skus.push(...newSkus);
    const newTasks = this.buildTasksForRange(startIndex, newSkus);
    this.tasks.push(...newTasks);
    return newTasks;
  }

  buildTasksForRange(startIndex, skus) {
    const now = new Date();
    return skus.map((sku, offset) => {
      const index = startIndex + offset;
      const id = BigInt(this.taskIdOffset) + BigInt(index);
      const importTaskId = BigInt(this.importTaskIdOffset) + BigInt(index);
      const goodsItemId = BigInt(this.goodsItemIdOffset) + BigInt(index);
      const createDate = formatTimestamp(now);
      const assignTime = createDate;
      const updateDate = createDate;
      const startTime = offsetTimestamp(now, index);

      return {
        assignTime,
        createDate,
        creator: this.creator,
        errorMessage: null,
        finishTime: null,
        goodsItemId: String(goodsItemId),
        goodsNameCn: String(index + 1),
        goodsNameEn: null,
        id: String(id),
        importTaskId: String(importTaskId),
        nodeCode: this.nodeCode || 'crawler-04',
        nodeId: this.nodeId,
        retryCount: 0,
        sku,
        startTime,
        status: 'CRAWLING',
        updateDate,
        updater: this.updater,
      };
    });
  }

  reset() {
    return this.setTasks(this.skus);
  }

  getStats() {
    return {
      code: 0,
      totalTasks: this.tasks.length,
      completedCount: this.completedTaskIds.size,
      issuedCount: this.issuedTaskIds.size,
      remainingCount: this.tasks.length - this.completedTaskIds.size,
      callbackCount: this.callbacks.length,
      uniqueCallbackCount: this.callbackIds.size,
      duplicateCallbacks: this.duplicateCallbacks,
      successCallbacks: this.successCallbacks,
      failedCallbacks: this.failedCallbacks,
      failureRate: this.failureRate,
    };
  }

  handleRequest(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedBody = body ? JSONbig.parse(body) : {};

        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSONbig.stringify({
            status: 'ok',
            skuCount: this.skus.length,
            totalTasks: this.tasks.length,
            completedCount: this.completedTaskIds.size,
            issuedCount: this.issuedTaskIds.size,
          }));
          return;
        }

        if (req.url === '/stats' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSONbig.stringify(this.getStats()));
          return;
        }

        if (req.url === '/renren-api/classify/open/crawler/tasks' && req.method === 'POST') {
          const { limit = 10 } = parsedBody;
          const requestedNodeCode = parsedBody.nodeCode || 'crawler-04';

          const tasks = [];
          for (const task of this.tasks) {
            if (this.completedTaskIds.has(task.id)) continue;
            this.issuedTaskIds.add(task.id);
            tasks.push({
              ...task,
              nodeCode: requestedNodeCode,
            });
            if (tasks.length >= Number(limit)) break;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSONbig.stringify({ code: 0, data: tasks }));
          return;
        }

        if (req.url === '/renren-api/classify/open/crawler/callback' && req.method === 'POST') {
          const callback = parsedBody;
          this.callbacks.push(callback);

          if (callback.success) {
            this.successCallbacks++;
          } else {
            this.failedCallbacks++;
          }

          const callbackId = callback.crawlerTaskId !== undefined
            ? String(callback.crawlerTaskId)
            : `${callback.sku}-${callback.nodeCode}`;

          if (this.callbackIds.has(callbackId)) {
            this.duplicateCallbacks++;
          } else {
            this.callbackIds.add(callbackId);
          }

          // A task is considered completed as soon as a callback is received,
          // regardless of whether success is true or false. The upstream system
          // treats any callback response as the final result for that task.
          // Re-polling only happens when the crawler fails to deliver a callback
          // (e.g. network error or crawler crash before pushing).
          const completedTaskId = callback.crawlerTaskId !== undefined
            ? String(callback.crawlerTaskId)
            : null;
          if (completedTaskId) {
            this.completedTaskIds.add(completedTaskId);
          }

          const failedByRate = this.failureRate > 0 && Math.random() < this.failureRate;
          const responseStatus = failedByRate ? 500 : 200;
          const responseBody = failedByRate
            ? { code: 500, error: 'simulated callback failure' }
            : { code: 0 };

          if (this.onCallback) {
            try {
              this.onCallback(callback, { status: responseStatus, body: responseBody });
            } catch (e) {
              // Hook errors should not break the callback response.
              console.error('[MOCK-PRODUCTION] onCallback hook error:', e.message);
            }
          }

          res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
          res.end(JSONbig.stringify(responseBody));
          return;
        }

        res.writeHead(404);
        res.end('not found');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSONbig.stringify({ code: 500, error: e.message }));
      }
    });
  }

  async start() {
    if (this.skus.length === 0 && this.autoLoad) {
      await this.loadSkus();
    }

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
          getStats: () => this.getStats(),
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

async function startMockProductionServer(options = {}) {
  const server = new MockProductionServer(options);
  return server.start();
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    port: 3456,
    host: '127.0.0.1',
    excelPath: path.resolve(__dirname, '../../mock_test/mocktest.xlsx'),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--excel' && i + 1 < args.length) {
      options.excelPath = args[i + 1];
      i++;
    } else if (args[i] === '--max-tasks' && i + 1 < args.length) {
      options.maxTasks = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--failure-rate' && i + 1 < args.length) {
      options.failureRate = Number(args[i + 1]);
      i++;
    }
  }

  const server = await startMockProductionServer(options);
  const stats = server.getStats();
  console.log(`[MOCK-PRODUCTION] Server running at ${server.url}`);
  console.log(`[MOCK-PRODUCTION] Total SKUs loaded: ${stats.totalTasks}${options.maxTasks ? ` (limited from mock_test by --max-tasks)` : ''}`);
  console.log(`[MOCK-PRODUCTION] Endpoints:`);
  console.log(`  POST ${server.url}/renren-api/classify/open/crawler/tasks`);
  console.log(`  POST ${server.url}/renren-api/classify/open/crawler/callback`);
  console.log(`  GET  ${server.url}/stats`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { MockProductionServer, startMockProductionServer };
