const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const { fetchExitInfo } = require('../src/proxy-exit-check');

// 本地 CONNECT 代理 + 本地 HTTP 目标，端到端验证 fetchExitInfo 的
// CONNECT 握手、Proxy-Authorization 传递、响应解析与超时处理。

function startTargetServer(body) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startConnectProxy({ onConnect } = {}) {
  const server = net.createServer((client) => {
    let buffer = '';
    let handled = false;
    client.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      handled = true;
      if (onConnect) onConnect(buffer.slice(0, headerEnd));
      const requestLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const target = requestLine.split(' ')[1];
      const [host, port] = target.split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buffer.slice(headerEnd + 4);
        if (rest) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('fetchExitInfo', () => {
  const servers = [];
  after(() => {
    for (const s of servers) {
      try { s.close(); } catch (e) {}
    }
  });

  it('fetches and parses exit info through a CONNECT proxy', async () => {
    const target = await startTargetServer({ ip: '1.2.3.4', org: 'AS9145 EWE TEL GmbH', country: 'DE' });
    servers.push(target);
    const targetPort = target.address().port;

    let connectHeader = '';
    const proxy = await startConnectProxy({ onConnect: (h) => { connectHeader = h; } });
    servers.push(proxy);
    const proxyPort = proxy.address().port;

    const info = await fetchExitInfo(`http://user:pass@127.0.0.1:${proxyPort}`, {
      host: '127.0.0.1',
      port: targetPort,
      path: '/json',
      secure: false,
      timeoutMs: 3000,
    });

    assert.strictEqual(info.ip, '1.2.3.4');
    assert.strictEqual(info.org, 'AS9145 EWE TEL GmbH');
    const expectedAuth = `Proxy-Authorization: Basic ${Buffer.from('user:pass').toString('base64')}`;
    assert.ok(connectHeader.includes(expectedAuth), `CONNECT should carry proxy auth, got: ${connectHeader}`);
  });

  it('rejects when the proxy never responds (hung upstream)', async () => {
    // 代理接受连接但永远不响应 CONNECT
    const silent = net.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    servers.push(silent);

    await assert.rejects(
      () => fetchExitInfo(`http://user:pass@127.0.0.1:${silent.address().port}`, {
        host: '127.0.0.1',
        port: 1,
        path: '/json',
        secure: false,
        timeoutMs: 300,
      }),
      /timeout/i
    );
  });

  it('rejects when CONNECT returns a non-200 status', async () => {
    const refusing = net.createServer((client) => {
      client.on('data', () => {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });
    await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    servers.push(refusing);

    await assert.rejects(
      () => fetchExitInfo(`http://user:pass@127.0.0.1:${refusing.address().port}`, {
        host: '127.0.0.1',
        port: 1,
        path: '/json',
        secure: false,
        timeoutMs: 2000,
      }),
      /403/
    );
  });
});
