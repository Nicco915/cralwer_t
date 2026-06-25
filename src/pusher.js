const JSONbig = require('json-bigint')({ useNativeBigInt: true });

class Pusher {
  constructor(options) {
    this.callbackUrl = options.callbackUrl;
    this.nodeCode = options.nodeCode;
    this.nodeToken = options.nodeToken || '';
    this.maxRetries = options.maxRetries || 3;
    this.retryDelays = options.retryDelays || [1000, 2000, 4000];
    this.fetch = options.fetch || globalThis.fetch;
  }

  buildBody(result) {
    const isSuccess = result.status === 'success';
    return {
      crawlerTaskId: result.crawlerTaskId,
      sku: result.sku,
      nodeCode: this.nodeCode,
      nodeToken: this.nodeToken,
      goodsName: result.product_name || '',
      goodsDesc: result.features_details || '',
      sourceUrl: result.product_url || '',
      rawContent: result.product_specification || '',
      success: isSuccess,
      errorMessage: result.error || '',
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async push(result) {
    const body = this.buildBody(result);
    let lastError = null;

    console.log(`[PUSHER] Start pushing task ${result.crawlerTaskId} sku ${result.sku} status=${result.status} to ${this.callbackUrl}`);
    console.log(`[PUSHER] Body ${result.crawlerTaskId}: ${JSONbig.stringify(body)}`);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`[PUSHER] Retrying task ${result.crawlerTaskId}, attempt ${attempt}/${this.maxRetries}`);
      }
      try {
        const response = await this.fetch(this.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSONbig.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Callback failed: ${response.status} ${text}`);
        }

        console.log(`[PUSHER] Success task ${result.crawlerTaskId}, response=${response.status}`);
        return;
      } catch (e) {
        lastError = e;
        console.error(`[PUSHER] Failed task ${result.crawlerTaskId} attempt ${attempt}: ${e.message}`);
        if (attempt < this.maxRetries) {
          const delay = this.retryDelays[attempt] || 4000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Callback failed after retries');
  }
}

module.exports = { Pusher };
