const http = require('http');

function startMockUploadServer() {
  let uploadCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/upload' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        uploadCount++;
        let parsed;
        try {
          parsed = JSON.parse(body || '{}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 400, error: 'invalid json' }));
          return;
        }
        const fileSize = typeof parsed.imageBase64 === 'string'
          ? Math.ceil(parsed.imageBase64.length * 0.75)
          : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            id: Date.now() + uploadCount,
            sku: parsed.sku,
            contentType: parsed.contentType,
            fileName: parsed.fileName,
            fileSize,
          },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/upload`,
        getUploadCount: () => uploadCount,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startMockUploadServer };