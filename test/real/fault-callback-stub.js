#!/usr/bin/env node
const http = require('http');

const args = process.argv.slice(2);
let port = parseInt(process.env.FAULT_CALLBACK_STUB_PORT || '19000', 10);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
}

function log(...messages) {
  console.log('[FAULT-CALLBACK-STUB]', ...messages);
}

let totalRequests = 0;
let lastBody = null;
let blocked = true;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', blocked }));
    return;
  }

  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalRequests, blocked, lastBody }));
    return;
  }

  if (req.method === 'POST' && req.url === '/control/allow') {
    blocked = false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blocked }));
    log('Switched to ALLOW mode via /control/allow');
    return;
  }

  if (req.method === 'POST' && req.url === '/control/block') {
    blocked = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blocked }));
    log('Switched to BLOCK mode via /control/block');
    return;
  }

  if (req.method === 'POST' && req.url === '/callback') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      totalRequests++;
      try {
        lastBody = JSON.parse(body || '{}');
      } catch {
        lastBody = { raw: body };
      }

      if (blocked) {
        log(`Blocked callback #${totalRequests}:`, lastBody.crawlerTaskId || 'unknown');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: -1, message: 'blocked by fault tolerance test' }));
        return;
      }

      log(`Allowed callback #${totalRequests}:`, lastBody.crawlerTaskId || 'unknown');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: -1, message: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  log(`Listening on http://${address.address}:${address.port}/callback`);
  log(`Health check: GET http://${address.address}:${address.port}/health`);
  log(`Stats:        GET http://${address.address}:${address.port}/stats`);
  log(`Control:      POST http://${address.address}:${address.port}/control/{allow|block}`);
});

function shutdown() {
  log('Shutting down...');
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
