const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KuaidailiClient } = require('../src/kuaidaili-client');

describe('KuaidailiClient', () => {
  const cacheDir = path.join(__dirname, 'tmp-kdl-cache');

  function setup() {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  }

  function cleanup() {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }

  it('full flow: fetches token then proxies and includes signature', async () => {
    setup();
    const cacheFile = path.join(cacheDir, 'token-cache.json');

    let fetchCalls = [];
    const fakeFetch = async (url, options) => {
      fetchCalls.push({ url: url.toString(), options });
      if (url.toString().includes('get_secret_token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              secret_token: 'tok123',
              expire: 3600,
            },
          }),
        };
      }
      if (url.toString().includes('getkps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              proxy_list: [
                'http://proxy1.example.com:8080',
                'http://proxy2.example.com:8080',
              ],
            },
          }),
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const client = new KuaidailiClient({
      secretId: 'sid',
      secretKey: 'skey',
      proxyType: 'kps',
      tokenCacheFile: cacheFile,
      fetch: fakeFetch,
    });

    const proxies = await client.getKpsProxies();

    assert.strictEqual(proxies.length, 2);
    assert.strictEqual(proxies[0], 'http://proxy1.example.com:8080');

    const getkpsCall = fetchCalls.find(c => c.url.includes('getkps'));
    assert.ok(getkpsCall, 'expected getkps call');
    const getkpsUrl = new URL(getkpsCall.url);
    assert.strictEqual(getkpsUrl.searchParams.get('signature'), 'tok123');
    assert.strictEqual(getkpsUrl.searchParams.get('format'), 'json');
    assert.strictEqual(getkpsUrl.searchParams.get('num'), '1000');

    const tokenCall = fetchCalls.find(c => c.url.includes('get_secret_token'));
    assert.ok(tokenCall, 'expected get_secret_token call');
    assert.strictEqual(tokenCall.options?.method, 'POST');
    assert.strictEqual(tokenCall.options?.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(tokenCall.options?.body?.includes('secret_id=sid'), 'expected body to include secret_id');
    assert.ok(tokenCall.options?.body?.includes('secret_key=skey'), 'expected body to include secret_key');

    cleanup();
  });

  it('reuses cached token and skips get_secret_token', async () => {
    setup();
    const cacheFile = path.join(cacheDir, 'token-cache.json');

    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        secret_token: 'cachedTok',
        expire_time: Math.floor(Date.now() / 1000) + 3600,
      })
    );

    let fetchCalls = [];
    const fakeFetch = async (url, options) => {
      fetchCalls.push({ url: url.toString(), options });
      if (url.toString().includes('getkps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              proxy_list: ['http://proxy3.example.com:8080'],
            },
          }),
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const client = new KuaidailiClient({
      secretId: 'sid',
      secretKey: 'skey',
      proxyType: 'kps',
      tokenCacheFile: cacheFile,
      fetch: fakeFetch,
    });

    const proxies = await client.getKpsProxies();

    assert.strictEqual(proxies.length, 1);
    assert.strictEqual(proxies[0], 'http://proxy3.example.com:8080');

    const getkpsCall = fetchCalls.find(c => c.url.includes('getkps'));
    assert.ok(getkpsCall, 'expected getkps call');
    const getkpsUrl = new URL(getkpsCall.url);
    assert.strictEqual(getkpsUrl.searchParams.get('signature'), 'cachedTok');

    const tokenCall = fetchCalls.find(c => c.url.includes('get_secret_token'));
    assert.strictEqual(tokenCall, undefined, 'should not call get_secret_token when cache is valid');

    cleanup();
  });
});
