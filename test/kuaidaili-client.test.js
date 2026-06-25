const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { KuaidailiClient } = require('../src/kuaidaili-client');

describe('KuaidailiClient', () => {
  function buildExpectedSignature(secretKey, method, endpoint, params) {
    const sorted = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        acc[key] = params[key];
        return acc;
      }, {});
    const query = Object.entries(sorted).map(([k, v]) => `${k}=${v}`).join('&');
    const path = endpoint.split('.com')[1];
    const rawStr = `${method}${path}?${query}`;
    return crypto.createHmac('sha1', secretKey).update(rawStr).digest().toString('base64');
  }

  it('getKpsProxies uses hmacsha1 signature and does not call get_secret_token', async () => {
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
      proxyNum: 5,
      fetch: fakeFetch,
    });

    const proxies = await client.getKpsProxies();

    assert.strictEqual(proxies.length, 2);
    assert.strictEqual(proxies[0], 'http://proxy1.example.com:8080');

    const tokenCall = fetchCalls.find(c => c.url.includes('get_secret_token'));
    assert.strictEqual(tokenCall, undefined, 'should not call get_secret_token with hmacsha1');

    const getkpsCall = fetchCalls.find(c => c.url.includes('getkps'));
    assert.ok(getkpsCall, 'expected getkps call');

    const getkpsUrl = new URL(getkpsCall.url);
    assert.strictEqual(getkpsUrl.searchParams.get('secret_id'), 'sid');
    assert.strictEqual(getkpsUrl.searchParams.get('sign_type'), 'hmacsha1');
    assert.ok(getkpsUrl.searchParams.get('timestamp'), 'expected timestamp');
    assert.strictEqual(getkpsUrl.searchParams.get('num'), '5');
    assert.strictEqual(getkpsUrl.searchParams.get('format'), 'json');

    const timestamp = getkpsUrl.searchParams.get('timestamp');
    const params = {
      secret_id: 'sid',
      sign_type: 'hmacsha1',
      timestamp,
      num: '5',
      format: 'json',
    };
    const expectedSig = buildExpectedSignature('skey', 'GET', 'kps.kdlapi.com/api/getkps', params);
    assert.strictEqual(getkpsUrl.searchParams.get('signature'), expectedSig);
  });

  it('internal signing helpers match official SDK semantics', () => {
    const client = new KuaidailiClient({
      secretId: 'sid',
      secretKey: 'skey',
      fetch: async () => ({}),
    });

    const params = {
      secret_id: 'sid',
      sign_type: 'hmacsha1',
      timestamp: 1234567890,
      num: '5',
      format: 'json',
    };
    const rawStr = client._getStringToSign('GET', 'kps.kdlapi.com/api/getkps', params);
    assert.strictEqual(rawStr, 'GET/api/getkps?format=json&num=5&secret_id=sid&sign_type=hmacsha1&timestamp=1234567890');

    const signature = client._sign(rawStr);
    const expectedSig = crypto
      .createHmac('sha1', 'skey')
      .update(rawStr)
      .digest()
      .toString('base64');
    assert.strictEqual(signature, expectedSig);
  });

  it('getProxyAuthorization uses hmacsha1 signature and returns auth data', async () => {
    let fetchCalls = [];
    const fakeFetch = async (url, options) => {
      fetchCalls.push({ url: url.toString(), options });
      if (url.toString().includes('getproxyauthorization')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              username: 'kdl_user',
              password: 'kdl_pass',
            },
          }),
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const client = new KuaidailiClient({
      secretId: 'sid',
      secretKey: 'skey',
      fetch: fakeFetch,
    });

    const auth = await client.getProxyAuthorization(1);

    assert.strictEqual(auth.username, 'kdl_user');
    assert.strictEqual(auth.password, 'kdl_pass');

    const authCall = fetchCalls.find(c => c.url.includes('getproxyauthorization'));
    assert.ok(authCall, 'expected getproxyauthorization call');

    const authUrl = new URL(authCall.url);
    assert.strictEqual(authUrl.searchParams.get('secret_id'), 'sid');
    assert.strictEqual(authUrl.searchParams.get('sign_type'), 'hmacsha1');
    assert.strictEqual(authUrl.searchParams.get('plaintext'), '1');

    const timestamp = authUrl.searchParams.get('timestamp');
    const params = {
      secret_id: 'sid',
      sign_type: 'hmacsha1',
      timestamp,
      plaintext: '1',
    };
    const expectedSig = buildExpectedSignature('skey', 'GET', 'dev.kdlapi.com/api/getproxyauthorization', params);
    assert.strictEqual(authUrl.searchParams.get('signature'), expectedSig);
  });
});
