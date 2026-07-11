const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Pusher } = require('../src/pusher');

describe('Pusher.buildBody regionCode', () => {
  it('includes regionCode from the result', () => {
    const pusher = new Pusher({ callbackUrl: 'http://x/callback', nodeCode: 'n1', nodeToken: 't' });
    const body = pusher.buildBody({ crawlerTaskId: 1, sku: 'S', status: 'success', regionCode: 'CA' });
    assert.strictEqual(body.regionCode, 'CA');
  });

  it('defaults regionCode to empty string when absent', () => {
    const pusher = new Pusher({ callbackUrl: 'http://x/callback', nodeCode: 'n1', nodeToken: 't' });
    const body = pusher.buildBody({ crawlerTaskId: 1, sku: 'S', status: 'error' });
    assert.strictEqual(body.regionCode, '');
  });
});
