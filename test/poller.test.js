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
        text: async () => JSON.stringify({
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
    assert.strictEqual(typeof tasks[0].crawlerTaskId, 'bigint');
    assert.strictEqual(tasks[0].crawlerTaskId, 1n);
    assert.strictEqual(tasks[0].sku, 'ABC-001');
  });

  it('preserves precision of large upstream numeric ids as BigInt', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      // Raw JSON text is used on purpose: JavaScript number literals lose
      // precision for 19-digit integers, so we must not build this via JSON.stringify.
      text: async () => '{"code":0,"data":[{"id":2070043611483398145,"sku":"ABC-001"}]}',
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    const tasks = await poller.fetchTasks();

    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(typeof tasks[0].crawlerTaskId, 'bigint');
    assert.strictEqual(tasks[0].crawlerTaskId, 2070043611483398145n);
    assert.strictEqual(tasks[0].sku, 'ABC-001');
  });

  it('preserves string ids from upstream as strings', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":0,"data":[{"id":"2070310839139160065","sku":"MJSNLDGG3C25UTA9DV0"}]}',
    });

    const poller = new Poller({
      taskUrl: 'http://example.com/tasks',
      nodeCode: 'node-1',
      nodeToken: 'token-1',
      fetch: fakeFetch,
    });

    const tasks = await poller.fetchTasks();

    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(typeof tasks[0].crawlerTaskId, 'string');
    assert.strictEqual(tasks[0].crawlerTaskId, '2070310839139160065');
    assert.strictEqual(tasks[0].sku, 'MJSNLDGG3C25UTA9DV0');
  });

  it('returns empty array when upstream returns no tasks', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: [] }),
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
      text: async () => JSON.stringify({ code: 0 }),
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
        text: async () => JSON.stringify({
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
