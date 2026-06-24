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

  /**
   * 生成签名原文字符串，与官方 SDK 语义一致：
   * METHOD + endpoint.path + '?' + 按 key 字典序排序后的 query string
   */
  _getStringToSign(method, endpoint, params) {
    const sortedKeys = Object.keys(params).sort();
    const query = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
    const path = endpoint.split('.com')[1];
    return `${method}${path}?${query}`;
  }

  /**
   * HMAC-SHA1 签名并 base64 编码，与官方 SDK 一致。
   */
  _sign(rawStr) {
    return crypto.createHmac('sha1', this.secretKey).update(rawStr).digest().toString('base64');
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
    body.set('sign_type', 'simple');
    body.set('signature', this.secretKey);

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
      throw new Error(`get_secret_token error: ${data.code}, msg: ${data.msg || 'unknown'}`);
    }

    const token = data.data.secret_token;
    const expireSeconds = Number(data.data.expire);
    const nowSec = Math.floor(Date.now() / 1000);
    const expireTime = nowSec + expireSeconds;

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
    const endpoint = 'kps.kdlapi.com/api/getkps';
    const params = {
      secret_id: this.secretId,
      sign_type: 'hmacsha1',
      timestamp: Date.now(),
      num: String(this.proxyNum),
      format: 'json',
    };

    const rawStr = this._getStringToSign('GET', endpoint, params);
    params.signature = this._sign(rawStr);

    const url = new URL(`https://${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const res = await this.fetch(url.toString());
    if (!res.ok) {
      throw new Error(`getkps failed: ${res.status}`);
    }
    const body = await res.json();
    if (body.code !== 0 || !body.data) {
      throw new Error(`getkps error: ${body.code}, msg: ${body.msg || 'unknown'}`);
    }

    return body.data.proxy_list || [];
  }
}

module.exports = { KuaidailiClient };
