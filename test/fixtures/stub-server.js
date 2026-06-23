const http = require('http');

function generateSkus(count) {
  return Array.from({ length: count }, (_, i) => ({
    crawlerTaskId: i + 1,
    sku: `TEST-SKU-${String(i + 1).padStart(4, '0')}`,
  }));
}

function buildSearchPage(sku, baseUrl) {
  const productUrl = `${baseUrl}/p/${encodeURIComponent(sku)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Search ${sku}</title>
  <script>
    window.dataLayer = [{
      search: {
        goods_list_params: {
          ["${sku}"]: {
            goodsUrl: "${productUrl}",
            title: "${sku} Product Name"
          }
        }
      }
    }];
  </script>
</head>
<body>
  <h1>Search results for ${sku}</h1>
</body>
</html>`;
}

function buildProductPage(sku) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${sku}</title>
</head>
<body>
  <h1>${sku} Product Name</h1>
  <div class="DM_features_details">
    <p>High quality ${sku}</p>
    <li>Feature A</li>
    <li>Feature B</li>
  </div>
  <div class="DM_product_specification">
    <h3>Product Specification</h3>
    <li><span class="DM_PS-label">Material</span>: <span class="DM_PS-value">Steel</span></li>
    <li><span class="DM_PS-label">Weight</span>: <span class="DM_PS-value">1kg</span></li>
    <li><span class="DM_PS-label">Dimensions</span>: <span class="DM_PS-value">10x10x10cm</span></li>
  </div>
  <img data-src="https://example.com/images/${sku}/original_img_1.jpg" alt="img1">
  <img data-src="https://example.com/images/${sku}/original_img_2.jpg" alt="img2">
</body>
</html>`;
}

class StubServer {
  constructor(options = {}) {
    this.port = options.port || 3456;
    this.host = options.host || '127.0.0.1';
    this.taskCount = options.taskCount || 200;
    this.tasks = generateSkus(this.taskCount);
    this.nextTaskIndex = 0;
    this.callbacks = [];
    this.callbackIds = new Set();
    this.duplicateCallbacks = 0;
    this.successCallbacks = 0;
    this.failedCallbacks = 0;
    this.server = null;
  }

  handleRequest(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedBody = body ? JSON.parse(body) : {};

        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (req.url === '/stats' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            taskCount: this.tasks.length,
            callbackCount: this.callbacks.length,
            uniqueCallbackCount: this.callbackIds.size,
            duplicateCallbacks: this.duplicateCallbacks,
            successCallbacks: this.successCallbacks,
            failedCallbacks: this.failedCallbacks,
          }));
          return;
        }

        if (req.url === '/renren-api/classify/open/crawler/tasks' && req.method === 'POST') {
          const { limit = 10 } = parsedBody;
          const startIndex = this.nextTaskIndex;
          const endIndex = Math.min(startIndex + Number(limit), this.tasks.length);
          this.nextTaskIndex = endIndex;
          const tasks = this.tasks.slice(startIndex, endIndex);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: tasks }));
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
          if (this.callbackIds.has(callback.crawlerTaskId)) {
            this.duplicateCallbacks++;
          } else {
            this.callbackIds.add(callback.crawlerTaskId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0 }));
          return;
        }

        if (req.url.startsWith('/s/') && req.method === 'GET') {
          const sku = decodeURIComponent(req.url.slice(3));
          const protocol = 'http';
          const baseUrl = `${protocol}://${req.headers.host || `127.0.0.1:${this.port}`}`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(buildSearchPage(sku, baseUrl));
          return;
        }

        if (req.url.startsWith('/p/') && req.method === 'GET') {
          const sku = decodeURIComponent(req.url.slice(3));
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(buildProductPage(sku));
          return;
        }

        res.writeHead(404);
        res.end('not found');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 500, error: e.message }));
      }
    });
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        const { port } = this.server.address();
        this.port = port;
        resolve({
          port: this.port,
          host: this.host,
          close: () => this.close(),
          getCallbacks: () => this.callbacks,
          getStats: () => ({
            taskCount: this.tasks.length,
            callbackCount: this.callbacks.length,
            uniqueCallbackCount: this.callbackIds.size,
            duplicateCallbacks: this.duplicateCallbacks,
            successCallbacks: this.successCallbacks,
            failedCallbacks: this.failedCallbacks,
          }),
        });
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}

async function startStubServer(options = {}) {
  const stub = new StubServer(options);
  return stub.start();
}

async function main() {
  const args = process.argv.slice(2);
  const options = { port: 3456, host: '127.0.0.1', taskCount: 200 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      options.port = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === '--task-count' && i + 1 < args.length) {
      options.taskCount = Number(args[i + 1]);
      i++;
    }
  }
  const server = await startStubServer(options);
  console.log(`[STUB] Server running at http://${options.host}:${server.port}`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { StubServer, startStubServer };
