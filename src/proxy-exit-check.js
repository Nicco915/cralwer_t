const net = require('net');
const tls = require('tls');

// 通过 HTTP CONNECT 代理查询出口信息（默认 mayips.com，返回 {country, ip, asn, ...}）。
// 用 mayips 而非 ipinfo：mayips 的 asn 字段与 cliproxy 官方语义一致，
// ipinfo 的 org 会把小 ISP 归并到上游（如 AS9145 显示成 AS3320 DTAG）造成误判。
// 用途：rotateProxy 换 IP 前验证新出口真实可用且命中目标 ASN——
// cliproxy 对无库存 ASN 静默回落其他池，也可能分到挂起的出口
// （CONNECT 接受后不响应），不校验会把浏览器 reinit 到死代理上。

function parseProxyUrl(proxyUrl) {
  let normalized = proxyUrl;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  const parsed = new URL(normalized);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 80,
    username: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
  };
}

function decodeChunked(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = parseInt(buffer.slice(offset, lineEnd).toString('utf8').trim(), 16);
    if (isNaN(size)) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    chunks.push(buffer.slice(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(chunks);
}

function parseHttpResponse(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    throw new Error('malformed HTTP response: no header terminator');
  }
  const headerText = raw.slice(0, headerEnd).toString('utf8');
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(headerText);
  if (!statusMatch) {
    throw new Error('malformed HTTP response: no status line');
  }
  const status = Number(statusMatch[1]);
  let body = raw.slice(headerEnd + 4);
  if (/transfer-encoding:\s*chunked/i.test(headerText)) {
    body = decodeChunked(body);
  }
  return { status, body };
}

async function fetchExitInfo(proxyUrl, options = {}) {
  const {
    host = 'mayips.com',
    port = 443,
    path = '/',
    secure = true,
    timeoutMs = 8000,
  } = options;

  const proxy = parseProxyUrl(proxyUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => {
      fail(new Error(`exit check timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const socket = net.connect(proxy.port, proxy.host);
    socket.on('error', fail);

    let handshake = Buffer.alloc(0);
    const onHandshakeData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(handshake.slice(0, headerEnd).toString('utf8'));
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (status !== 200) {
        fail(new Error(`proxy CONNECT failed with status ${status}`));
        return;
      }
      socket.off('data', onHandshakeData);

      let transport = socket;
      if (secure) {
        transport = tls.connect({ socket, servername: host });
        transport.on('error', fail);
      }

      let response = Buffer.alloc(0);
      transport.on('data', (chunk) => {
        response = Buffer.concat([response, chunk]);
      });
      transport.on('end', () => {
        try {
          const { status: respStatus, body } = parseHttpResponse(response);
          if (respStatus !== 200) {
            fail(new Error(`exit info endpoint returned status ${respStatus}`));
            return;
          }
          done(JSON.parse(body.toString('utf8')));
        } catch (e) {
          fail(e);
        }
      });
      transport.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: hs-sku-crawler-exit-check\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
      );
    };

    socket.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      socket.on('data', onHandshakeData);
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
  });
}

module.exports = { fetchExitInfo };
