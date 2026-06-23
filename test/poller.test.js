const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Poller } = require('../src/poller');

describe('Poller.fetchTasks', () => {
  it('returns tasks parsed from upstream response', async () => {
    const fetched = [];
    const fakeFetch = async (url, options) => {
      fetched.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: [
            { crawlerTaskId: 1, sku: 'ABC-001' },
            { crawlerTaskId: 2, sku: 'ABC-002' },
          ],
        }),
      };
    };

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      limit: 5,
      fetch: fakeFetch,
    });

    const tasks = await poller.fetchTasks();

    assert.strictEqual(fetched.length, 1);
    assert.strictEqual(fetched[0].url, 'http://example.com/tasks');
    assert.strictEqual(fetched[0].options.method, 'POST');
    assert.strictEqual(fetched[0].options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(fetched[0].options.body);
    assert.strictEqual(body.nodeCode, 'node-1');
    assert.strictEqual(body.nodeToken, 'token-1');
    assert.strictEqual(body.limit, 5);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].crawlerTaskId, 1);
    assert.strictEqual(tasks[0].sku, 'ABC-001');
  });

  it('returns empty array when upstream returns no tasks', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: [] }),
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    const tasks = await poller.fetchTasks();
    assert.deepStrictEqual(tasks, []);
  });

  it('returns empty array when upstream response lacks data field', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0 }),
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    const tasks = await poller.fetchTasks();
    assert.deepStrictEqual(tasks, []);
  });

  it('throws when upstream returns non-ok status', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await assert.rejects(
      () => poller.fetchTasks(),
      /tasks failed: 500/
    );
  });

  it('throws when upstream returns invalid JSON', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
      text: async () => 'not json',
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    await assert.rejects(
      () => poller.fetchTasks(),
      /not json/
    );
  });
});

describe('Poller.start/stop', () => {
  it('polls periodically and stops', async () => {
    let callCount = 0;
    const fakeFetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: callCount === 1 ? [{ crawlerTaskId: 1, sku: 'ABC-001' }] : [],
        }),
      };
    };

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      pollInterval: 50,
      fetch: fakeFetch,
    });

    const received = [];
    poller.start((tasks) => {
      received.push(...tasks);
    });

    await new Promise(resolve => setTimeout(resolve, 120));
    poller.stop();

    assert.ok(callCount >= 2, `expected at least 2 polls, got ${callCount}`);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].sku, 'ABC-001');
  });
});
