const http = require('http');

function startMockUploadServer() {
  let uploadCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/upload' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        uploadCount++;
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            id: Date.now() + uploadCount,
            sku: parsed.sku,
            contentType: parsed.contentType,
            fileName: parsed.fileName,
            fileSize: parsed.imageBase64 ? Math.ceil(parsed.imageBase64.length * 0.75) : 0,
          },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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
