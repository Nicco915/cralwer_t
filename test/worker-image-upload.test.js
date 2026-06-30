const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('../src/worker');

describe('Worker image upload after callback', () => {
  function createChannel(options = {}) {
    return {
      id: options.id || 1,
      busy: options.busy || false,
      crawl: options.crawl || (async () => ({
        status: 'success',
        sku: 'ABC-001',
        product_name: '',
        features_details: '',
        product_specification: '',
        product_url: '',
        error: '',
        image_paths: '/tmp/images/ABC-001.jpg',
      })),
    };
  }

  it('calls imageUploader.upload after successful callback push', async () => {
    let callbackPushed = false;
    let uploadCalled = false;

    const fakePusher = {
      push: async (result) => {
        assert.strictEqual(result.status, 'success');
        callbackPushed = true;
      },
    };

    const fakeUploader = {
      upload: async (result) => {
        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.image_paths, '/tmp/images/ABC-001.jpg');
        uploadCalled = true;
        return { uploaded: [] };
      },
    };

    const worker = new Worker({
      pusher: fakePusher,
      imageUploader: fakeUploader,
      log: () => {},
    });

    worker.addChannel(createChannel());
    worker.pushTasks([{ crawlerTaskId: 1n, sku: 'ABC-001' }]);
    worker.start();
    await worker.drain();

    assert.strictEqual(callbackPushed, true);
    assert.strictEqual(uploadCalled, true);
  });

  it('does not call imageUploader.upload when callback push fails', async () => {
    let uploadCalled = false;

    const fakePusher = {
      push: async () => {
        throw new Error('callback push failed');
      },
    };

    const fakeUploader = {
      upload: async () => {
        uploadCalled = true;
        return { uploaded: [] };
      },
    };

    const worker = new Worker({
      pusher: fakePusher,
      imageUploader: fakeUploader,
      log: () => {},
    });

    worker.addChannel(createChannel());
    worker.pushTasks([{ crawlerTaskId: 1n, sku: 'ABC-001' }]);
    worker.start();
    await worker.drain();

    assert.strictEqual(uploadCalled, false);
  });
});
