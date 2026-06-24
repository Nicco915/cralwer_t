const fs = require('fs');
const crypto = require('crypto');

class KuaidailiClient {
  constructor(options) {
    this.secretId = options.secretId;
    this.secretKey = options.secretKey;
    this.proxyType = options.proxyType || 'kps';
    this.proxyNum = options.proxyNum !== undefined ? Number(options.proxyNum) : 1000;
    this.tokenCacheFile = options.tokenCacheFile || '.kdl_token';
    this.fetch = options.fetch || globalThis.fetch;
  }

  async getSecretToken() {
    const now = Math.floor(Date.now() / 1000);
    const minValid = now + 180; // 3 minutes buffer

    if (this.tokenCacheFile && fs.existsSync(this.tokenCacheFile)) {
      try {
        const raw = fs.readFileSync(this.tokenCacheFile, 'utf8');
        const cached = JSON.parse(raw);
        if (cached.expire_time && cached.expire_time > minValid) {
          return cached.secret_token;
        }
      } catch {
        // ignore corrupted cache
      }
    }

    const url = 'https://auth.kdlapi.com/api/get_secret_token';
    const body = new URLSearchParams();
    body.set('secret_id', this.secretId);
    body.set('secret_key', this.secretKey);

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`get_secret_token failed: ${res.status}`);
    }
    const data = await res.json();
    if (data.code !== 0 || !data.data) {
      throw new Error(`get_secret_token error: ${data.code}`);
    }

    const token = data.data.data.secret_token;
    const expireTime = data.data.data.expire;

    if (this.tokenCacheFile) {
      const cacheDir = require('path').dirname(this.tokenCacheFile);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(
        this.tokenCacheFile,
        JSON.stringify({ secret_token: token, expire_time: expireTime })
      );
    }

    return token;
  }

  async getKpsProxies() {
    const token = await this.getSecretToken();

    const url = new URL('https://kps.kdlapi.com/api/getkps');
    url.searchParams.set('secret_id', this.secretId);
    url.searchParams.set('signature', token);
    url.searchParams.set('format', 'json');
    url.searchParams.set('num', String(this.proxyNum));

    const res = await this.fetch(url.toString());
    if (!res.ok) {
      throw new Error(`getkps failed: ${res.status}`);
    }
    const body = await res.json();
    if (body.code !== 0 || !body.data) {
      throw new Error(`getkps error: ${body.code}`);
    }

    return body.data.proxy_list || [];
  }
}

module.exports = { KuaidailiClient };
