const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const subprocess = require('child_process');
const { PageCrawler } = require('./page-crawler');
const { createProfile } = require('./stealth-profile');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_LOCALE = 'en-GB';
const DEFAULT_TIMEZONE = 'Europe/London';

const DEFAULT_CONFIG = {
  inputExcel: null,
  outputDir: './output',
  imageDir: null,
  checkpointFile: null,
  resultPath: null,
  baseUrl: 'https://eur.vevor.com',
  userAgent: DEFAULT_USER_AGENT,
  viewport: DEFAULT_VIEWPORT,
  locale: DEFAULT_LOCALE,
  timezone: DEFAULT_TIMEZONE,
  browserPath: null,
  minDelay: 5,
  maxDelay: 10,
  flushInterval: 10,
  order: 'forward',
  headless: true,
  enableTranslation: true,
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || '',
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  dashscopeModel: 'qwen3.6-flash-2026-04-16',
  translationConcurrency: 5,
  translationMaxRetries: 3,
  translationRetryDelays: [1000, 2000, 4000],
  translationQueueCapacity: 20,
  enableFeishu: false,
  feishuTo: 'feishu',
  maxImages: 5,
  cloudflareMaxWait: 45,
  dataLayerMaxRetries: 1,
  dataLayerFailureThreshold: 3,
  handleSignals: true,
  testCount: 0,
};

function resolveConfig(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  cfg.nodeCode = cfg.nodeCode || process.env.CRAWLER_NODE_CODE || os.hostname() || 'crawler-01';
  cfg.stealthMode = cfg.stealthMode || process.env.CRAWLER_STEALTH_MODE || 'channel';

  if (!cfg.inputExcel) {
    throw new Error('Missing required config: inputExcel');
  }
  cfg.inputExcel = path.resolve(cfg.inputExcel);

  cfg.outputDir = path.resolve(cfg.outputDir);
  if (!cfg.imageDir) cfg.imageDir = path.join(cfg.outputDir, 'images');
  else cfg.imageDir = path.resolve(cfg.imageDir);

  if (!cfg.checkpointFile) cfg.checkpointFile = path.join(cfg.outputDir, 'checkpoint.json');
  else cfg.checkpointFile = path.resolve(cfg.checkpointFile);

  if (!cfg.resultPath) cfg.resultPath = path.join(cfg.outputDir, 'vevor_result.xlsx');
  else cfg.resultPath = path.resolve(cfg.resultPath);

  cfg.order = String(cfg.order).toLowerCase();
  if (cfg.order !== 'forward' && cfg.order !== 'reverse') {
    throw new Error(`Invalid order: ${cfg.order}. Use 'forward' or 'reverse'.`);
  }

  cfg.headless = cfg.headless !== false && cfg.headless !== 'false';
  cfg.enableTranslation = cfg.enableTranslation !== false && cfg.enableTranslation !== 'false';
  cfg.enableFeishu = cfg.enableFeishu === true || cfg.enableFeishu === 'true';

  cfg.minDelay = Number(cfg.minDelay);
  cfg.maxDelay = Number(cfg.maxDelay);
  cfg.flushInterval = Number(cfg.flushInterval);
  cfg.translationConcurrency = Number(cfg.translationConcurrency);
  cfg.translationMaxRetries = Number(cfg.translationMaxRetries);
  cfg.translationQueueCapacity = Number(cfg.translationQueueCapacity);
  cfg.maxImages = Number(cfg.maxImages);
  cfg.cloudflareMaxWait = Number(cfg.cloudflareMaxWait);
  cfg.testCount = Number(cfg.testCount);

  return cfg;
}

function resolveBrowserPath(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  // 允许通过环境变量强制使用 Playwright 自带的 Chromium
  // 设置 CRAWLER_BROWSER_PATH= 空字符串时跳过 Edge 检测
  if (Object.prototype.hasOwnProperty.call(process.env, 'CRAWLER_BROWSER_PATH')) {
    const envPath = process.env.CRAWLER_BROWSER_PATH;
    if (!envPath) {
      return undefined;
    }
    if (fs.existsSync(envPath)) {
      return envPath;
    }
    console.warn(`[BROWSER] CRAWLER_BROWSER_PATH=${envPath} not found, falling back to bundled Chromium`);
    return undefined;
  }

  const platform = os.platform();
  const candidates = {
    win32: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwin: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    ],
  };

  for (const p of candidates[platform] || []) {
    if (fs.existsSync(p)) return p;
  }

  return undefined;
}

class VevorCrawler {
  constructor(config) {
    this.config = resolveConfig(config);
    this.interrupted = false;
    this.doFlush = null;
  }

  log(...args) {
    console.log(...args);
  }

  sendFeishuMessage(message, filePath = null) {
    if (!this.config.enableFeishu) return;
    try {
      const to = this.config.feishuTo;
      const textCmd = ['hermes', 'send', '--to', to, '--quiet', message];
      const textResult = subprocess.spawnSync(textCmd[0], textCmd.slice(1), { encoding: 'utf-8', timeout: 60000 });
      if (textResult.status !== 0) {
        this.log(`[FEISHU] Text send failed: ${textResult.stderr}`);
      } else {
        this.log(`[FEISHU] Text sent: ${message.slice(0, 80)}...`);
      }

      if (filePath && fs.existsSync(filePath)) {
        const fileCmd = ['hermes', 'send', '--to', to, '--quiet', `MEDIA:${filePath}`];
        const fileResult = subprocess.spawnSync(fileCmd[0], fileCmd.slice(1), { encoding: 'utf-8', timeout: 120000 });
        if (fileResult.status !== 0) {
          this.log(`[FEISHU] File send failed: ${fileResult.stderr}`);
        } else {
          this.log(`[FEISHU] File sent: ${path.basename(filePath)}`);
        }
      }
    } catch (e) {
      this.log(`[FEISHU] Error: ${e.message}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  randomDelay() {
    const { minDelay, maxDelay } = this.config;
    return Math.floor(minDelay * 1000 + Math.random() * (maxDelay - minDelay) * 1000);
  }

  generateTimestampedFilename(basePath) {
    if (!fs.existsSync(basePath)) return basePath;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ext = path.extname(basePath);
    const base = path.join(path.dirname(basePath), `${path.basename(basePath, ext)}_${ts}${ext}`);

    if (fs.existsSync(base)) {
      const ms = String(now.getMilliseconds()).padStart(3, '0');
      return path.join(path.dirname(basePath), `${path.basename(basePath, ext)}_${ts}_${ms}${ext}`);
    }
    return base;
  }

  loadCheckpoint() {
    const { checkpointFile } = this.config;
    const defaults = {
      completed_skus: [],
      failed_skus: [],
      not_found_skus: [],
      mismatched_skus: [],
      current_batch: 1,
      last_processed_index: -1,
    };
    if (fs.existsSync(checkpointFile)) {
      const saved = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'));
      return { ...defaults, ...saved };
    }
    return defaults;
  }

  saveCheckpoint(checkpoint) {
    fs.writeFileSync(this.config.checkpointFile, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  initOutputWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Results');
    worksheet.columns = [
      { header: 'sku', key: 'sku', width: 25 },
      { header: 'product_name', key: 'product_name', width: 50 },
      { header: 'features_details', key: 'features_details', width: 60 },
      { header: 'product_specification', key: 'product_specification', width: 40 },
      { header: 'image_1', key: 'image_1', width: 25 },
      { header: 'image_2', key: 'image_2', width: 25 },
      { header: 'image_3', key: 'image_3', width: 25 },
      { header: 'image_4', key: 'image_4', width: 25 },
      { header: 'image_5', key: 'image_5', width: 25 },
      { header: 'status', key: 'status', width: 12 },
      { header: 'product_url', key: 'product_url', width: 60 },
      { header: 'error', key: 'error', width: 40 },
      { header: 'product_name_cn', key: 'product_name_cn', width: 50 },
      { header: 'features_details_cn', key: 'features_details_cn', width: 60 },
      { header: 'product_specification_cn', key: 'product_specification_cn', width: 40 },
    ];
    return { workbook, worksheet };
  }

  appendResultRow(worksheet, result) {
    worksheet.addRow({
      sku: result.sku || '',
      product_name: result.product_name || '',
      features_details: result.features_details || '',
      product_specification: result.product_specification || '',
      image_1: '',
      image_2: '',
      image_3: '',
      image_4: '',
      image_5: '',
      status: result.status || '',
      product_url: result.product_url || '',
      error: result.error || '',
      product_name_cn: result.product_name_cn || '',
      features_details_cn: result.features_details_cn || '',
      product_specification_cn: result.product_specification_cn || '',
    });
  }

  appendJsonl(jsonlPath, result) {
    fs.appendFileSync(jsonlPath, JSON.stringify(result) + '\n', 'utf-8');
  }

  async flushExcel(workbook, excelPath, pendingResults) {
    if (pendingResults.length === 0) return;
    await workbook.xlsx.writeFile(excelPath);
    this.log(`[FLUSH] ${pendingResults.length} rows saved -> ${path.basename(excelPath)}`);
  }

  createAsyncQueue(capacity = 20) {
    const queue = [];
    let closed = false;
    const waitingTakers = [];
    const waitingPushers = [];

    const resolveNext = () => {
      while (waitingTakers.length > 0 && queue.length > 0) {
        const { resolve } = waitingTakers.shift();
        resolve(queue.shift());
      }
      while (waitingPushers.length > 0 && queue.length < capacity) {
        const { item, resolve } = waitingPushers.shift();
        queue.push(item);
        resolve();
        if (waitingTakers.length > 0 && queue.length > 0) {
          const { resolve: tResolve } = waitingTakers.shift();
          tResolve(queue.shift());
        }
      }
    };

    const push = async (item) => {
      if (closed) throw new Error('Queue closed');
      if (queue.length < capacity) {
        queue.push(item);
        resolveNext();
        return;
      }
      await new Promise((resolve, reject) => {
        waitingPushers.push({ item, resolve, reject });
      });
    };

    const take = async () => {
      if (queue.length > 0) {
        const item = queue.shift();
        resolveNext();
        return item;
      }
      if (closed) return null;
      return new Promise((resolve, reject) => {
        waitingTakers.push({ resolve, reject });
      });
    };

    const close = () => {
      closed = true;
      while (waitingTakers.length > 0) waitingTakers.shift().resolve(null);
      while (waitingPushers.length > 0) waitingPushers.shift().resolve();
    };

    return { push, take, close, get size() { return queue.length; } };
  }

  createTranslationPrompt(result) {
    return `You are a professional e-commerce translator. Translate the following product fields from English to Chinese. Preserve line breaks and list formatting. Return ONLY a JSON object with exactly these keys: product_name_cn, features_details_cn, product_specification_cn. Do not include markdown code fences or any other text.

product_name:
${result.product_name || ''}

features_details:
${result.features_details || ''}

product_specification:
${result.product_specification || ''}`;
  }

  parseTranslationJson(raw) {
    if (!raw) throw new Error('Empty response');
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    const parsed = JSON.parse(text);
    if (typeof parsed.product_name_cn !== 'string' ||
        typeof parsed.features_details_cn !== 'string' ||
        typeof parsed.product_specification_cn !== 'string') {
      throw new Error('Missing required translation keys');
    }
    return parsed;
  }

  async translateWithRetry(result) {
    const {
      dashscopeApiKey,
      dashscopeBaseUrl,
      dashscopeModel,
      translationMaxRetries,
      translationRetryDelays,
    } = this.config;

    if (!dashscopeApiKey) {
      throw new Error('DASHSCOPE_API_KEY not set');
    }

    const prompt = this.createTranslationPrompt(result);
    const body = {
      model: dashscopeModel,
      messages: [
        { role: 'system', content: 'You translate English e-commerce product data into Chinese. Always return valid JSON with keys product_name_cn, features_details_cn, product_specification_cn.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    };

    let lastError = null;
    for (let attempt = 0; attempt <= translationMaxRetries; attempt++) {
      try {
        const response = await fetch(dashscopeBaseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${dashscopeApiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content;
        return this.parseTranslationJson(raw);
      } catch (e) {
        lastError = e;
        this.log(`[TRANSLATE][${result.sku}] Attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt < translationMaxRetries) {
          const delay = translationRetryDelays[attempt] || 4000;
          await this.sleep(delay);
        }
      }
    }
    throw lastError || new Error('Translation failed after retries');
  }

  async runTranslationWorkers(translationQueue, translatedQueue, count) {
    const { enableTranslation, dashscopeApiKey, translationConcurrency } = this.config;
    const doTranslate = enableTranslation && !!dashscopeApiKey;

    if (enableTranslation && !dashscopeApiKey) {
      this.log('[TRANSLATE] Translation enabled but DASHSCOPE_API_KEY not set, skipping translation.');
    }

    const workers = [];
    for (let i = 0; i < count; i++) {
      workers.push((async () => {
        while (true) {
          const item = await translationQueue.take();
          if (!item) break;
          const { rowIndex, result } = item;
          if (result.status !== 'success' || !doTranslate) {
            await translatedQueue.push({ rowIndex, result });
            continue;
          }
          try {
            const translated = await this.translateWithRetry(result);
            result.product_name_cn = translated.product_name_cn;
            result.features_details_cn = translated.features_details_cn;
            result.product_specification_cn = translated.product_specification_cn;
            this.log(`[TRANSLATE][${result.sku}] OK`);
          } catch (e) {
            result.status = 'success_translate_error';
            result.error = (result.error ? result.error + ' | ' : '') + `Translation failed: ${e.message}`;
            this.log(`[TRANSLATE][${result.sku}] FAILED: ${e.message}`);
          }
          await translatedQueue.push({ rowIndex, result });
        }
      })());
    }
    return Promise.all(workers);
  }

  classifyResult(checkpoint, result) {
    if (result.status === 'success') checkpoint.completed_skus.push(result.sku);
    else if (result.status === 'not_found') checkpoint.not_found_skus.push(result.sku);
    else if (result.status === 'sku_mismatch') checkpoint.mismatched_skus.push(result.sku);
    else checkpoint.failed_skus.push(result.sku);
  }

  processBufferedResult(r, worksheet, jsonlPath, pendingResults, checkpoint) {
    this.appendResultRow(worksheet, r);
    this.appendJsonl(jsonlPath, r);
    pendingResults.push(r);
    this.classifyResult(checkpoint, r);
    checkpoint.last_processed_index = r.globalIndex;
    this.saveCheckpoint(checkpoint);
  }

  async writerTask(translatedQueue, worksheet, jsonlPath, pendingResults, workbook, excelPath, checkpoint) {
    const rowBuffer = new Map();
    let nextRowIndex = 0;

    while (true) {
      const item = await translatedQueue.take();
      if (!item) break;
      const { rowIndex, result } = item;
      rowBuffer.set(rowIndex, result);

      while (rowBuffer.has(nextRowIndex)) {
        const r = rowBuffer.get(nextRowIndex);
        this.processBufferedResult(r, worksheet, jsonlPath, pendingResults, checkpoint);

        rowBuffer.delete(nextRowIndex);
        nextRowIndex++;

        if (pendingResults.length >= this.config.flushInterval || this.interrupted) {
          await this.flushExcel(workbook, excelPath, pendingResults);
          pendingResults.length = 0;
          if (this.interrupted) {
            this.log('[EXIT] Interrupted, writer stopping after current flush.');
            return;
          }
        }
      }
    }

    while (rowBuffer.size > 0 && rowBuffer.has(nextRowIndex)) {
      const r = rowBuffer.get(nextRowIndex);
      this.processBufferedResult(r, worksheet, jsonlPath, pendingResults, checkpoint);
      rowBuffer.delete(nextRowIndex);
      nextRowIndex++;

      if (pendingResults.length >= this.config.flushInterval || this.interrupted) {
        await this.flushExcel(workbook, excelPath, pendingResults);
        pendingResults.length = 0;
        if (this.interrupted) {
          this.log('[EXIT] Interrupted, writer stopping after current flush.');
          return;
        }
      }
    }

    // 处理 rowBuffer 中剩余的非连续数据，避免数据丢失
    if (rowBuffer.size > 0) {
      this.log(`[WRITER] Processing ${rowBuffer.size} remaining out-of-order rows`);
      for (const [rowIndex, r] of rowBuffer) {
        await this.processBufferedResult(r, worksheet, jsonlPath, pendingResults, checkpoint);
        rowBuffer.delete(rowIndex);

        if (pendingResults.length >= this.config.flushInterval || this.interrupted) {
          await this.flushExcel(workbook, excelPath, pendingResults);
          pendingResults.length = 0;
          if (this.interrupted) {
            this.log('[EXIT] Interrupted, writer stopping after current flush.');
            return;
          }
        }
      }
    }

    if (pendingResults.length > 0) {
      await this.flushExcel(workbook, excelPath, pendingResults);
      pendingResults.length = 0;
    }
  }

  async crawlSingleSku(sku, page, recreateContext) {
    const pageCrawler = new PageCrawler({
      baseUrl: this.config.baseUrl,
      imageDir: this.config.imageDir,
      userAgent: this.profile?.userAgent || this.config.userAgent,
      maxImages: this.config.maxImages,
      cloudflareMaxWait: this.config.cloudflareMaxWait,
      minDelay: this.config.minDelay,
      maxDelay: this.config.maxDelay,
      gotoMaxRetries: this.config.gotoMaxRetries,
      gotoTimeout: this.config.gotoTimeout,
      gotoRetryDelays: this.config.gotoRetryDelays,
      dataLayerMaxRetries: this.config.dataLayerMaxRetries,
    });
    return pageCrawler.crawlSingleSku(sku, page, recreateContext);
  }

  registerSignalHandlers() {
    const onSigint = async () => {
      this.log('\n[SIGINT] 收到中断信号，立即保存已完成的 SKU...');
      this.interrupted = true;
      if (this.doFlush) {
        try { await this.doFlush(); } catch (e) { this.log(`[SIGINT] Flush error: ${e.message}`); }
      }
      process.exit(0);
    };

    const onSigterm = async () => {
      this.log('\n[SIGTERM] 收到终止信号，立即保存已完成的 SKU...');
      this.interrupted = true;
      if (this.doFlush) {
        try { await this.doFlush(); } catch (e) { this.log(`[SIGTERM] Flush error: ${e.message}`); }
      }
      process.exit(0);
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  async run() {
    const {
      inputExcel,
      outputDir,
      imageDir,
      resultPath,
      order,
      headless,
      browserPath,
      handleSignals,
      translationConcurrency,
      translationQueueCapacity,
    } = this.config;

    if (!fs.existsSync(inputExcel)) {
      throw new Error(`Input file not found: ${inputExcel}`);
    }

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

    if (handleSignals) this.registerSignalHandlers();

    this.log(`Loading SKU list from ${inputExcel}...`);
    const inputWorkbook = new ExcelJS.Workbook();
    await inputWorkbook.xlsx.readFile(inputExcel);
    const inputWorksheet = inputWorkbook.worksheets[0];

    const headerRow = inputWorksheet.getRow(1);
    let skuColIndex = -1;
    headerRow.eachCell((cell, colNumber) => {
      if (cell.value && String(cell.value).trim().toUpperCase() === 'SKU') {
        skuColIndex = colNumber;
      }
    });

    if (skuColIndex === -1) {
      throw new Error('SKU column not found in Excel header');
    }

    let allSkus = [];
    inputWorksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const sku = row.getCell(skuColIndex).value;
      if (sku) allSkus.push(String(sku).trim());
    });

    this.log(`Total SKUs: ${allSkus.length}`);

    if (order === 'forward') {
      this.log('Order: forward');
    } else {
      allSkus = allSkus.reverse();
      this.log('Order: reverse');
    }

    if (this.config.testCount > 0) {
      allSkus = allSkus.slice(0, this.config.testCount);
      this.log(`Test mode: limited to ${allSkus.length} SKU(s)`);
    }

    const checkpoint = this.loadCheckpoint();
    const startIndex = checkpoint.last_processed_index + 1;
    this.log(`Already completed: ${checkpoint.completed_skus.length}`);
    this.log(`Failed: ${checkpoint.failed_skus.length}`);
    this.log(`Not found: ${checkpoint.not_found_skus.length}`);
    this.log(`Starting from index: ${startIndex}`);

    const remainingSkus = allSkus.slice(startIndex);
    if (remainingSkus.length === 0) {
      this.log('All SKUs already processed!');
      return;
    }

    const excelPath = this.generateTimestampedFilename(resultPath);
    const jsonlPath = excelPath.replace(/\.xlsx$/, '.jsonl');
    this.log(`Output Excel: ${excelPath}`);
    this.log(`Output JSONL: ${jsonlPath}`);

    const { workbook, worksheet } = this.initOutputWorkbook();
    const pendingResults = [];

    this.doFlush = async () => {
      if (pendingResults.length > 0) {
        await this.flushExcel(workbook, excelPath, pendingResults);
        pendingResults.length = 0;
      }
      this.saveCheckpoint(checkpoint);
    };

    const resolvedBrowser = resolveBrowserPath(browserPath);
    if (resolvedBrowser) {
      this.log(`[BROWSER] Using: ${resolvedBrowser}`);
    } else {
      this.log('[BROWSER] Edge not found, falling back to Playwright bundled Chromium');
    }

    const launchOptions = {
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--lang=en-GB',
      ],
    };

    if (resolvedBrowser) {
      launchOptions.executablePath = resolvedBrowser;
    } else {
      // Playwright 1.60+ 默认使用 chromium-headless-shell，但该二进制在某些安装环境下会缺失。
      // 指定 channel: 'chromium' 使用完整 Chromium 的 new headless 模式，部署更稳定。
      launchOptions.channel = 'chromium';
    }

    const browser = await chromium.launch(launchOptions);

    const profile = createProfile({
      nodeCode: this.config.nodeCode,
      channelId: 1,
      mode: this.config.stealthMode,
      fixedUserAgent: this.config.userAgent,
    });
    this.profile = profile;

    const context = await browser.newContext({
      userAgent: profile.userAgent,
      viewport: profile.viewport,
      locale: profile.locale,
      timezoneId: profile.timezoneId,
    });

    await context.addInitScript(profile.stealthScript);
    const page = await context.newPage();

    const translationQueue = this.createAsyncQueue(translationQueueCapacity);
    const translatedQueue = this.createAsyncQueue(translationQueueCapacity);

    try {
      const workersPromise = this.runTranslationWorkers(translationQueue, translatedQueue, translationConcurrency);
      const writerPromise = this.writerTask(translatedQueue, worksheet, jsonlPath, pendingResults, workbook, excelPath, checkpoint);

      for (let i = 0; i < remainingSkus.length; i++) {
        if (this.interrupted) {
          this.log('[EXIT] Interrupted, stopping crawl loop.');
          break;
        }

        const sku = remainingSkus[i];
        const globalIndex = startIndex + i;
        this.log(`\n${'='.repeat(60)}`);
        this.log(`[${globalIndex + 1}/${allSkus.length}] SKU: ${sku}`);
        this.log(`${'='.repeat(60)}`);

        const result = await this.crawlSingleSku(sku, page, null);
        result.globalIndex = globalIndex;

        await translationQueue.push({ rowIndex: i, result });

        if (i < remainingSkus.length - 1 && !this.interrupted) {
          const delay = this.randomDelay();
          this.log(`[DELAY] Waiting ${(delay / 1000).toFixed(1)}s...`);
          await this.sleep(delay);
        }
      }

      this.log('[CRAWL] 所有 SKU 爬取完成，等待翻译和写入结束...');
      translationQueue.close();
      await workersPromise;
      translatedQueue.close();
      await writerPromise;

      if (pendingResults.length > 0) {
        await this.flushExcel(workbook, excelPath, pendingResults);
        pendingResults.length = 0;
      }

      this.log(`\n${'='.repeat(60)}`);
      this.log('VEVOR 爬取全部完成!');
      this.log(`总计: ${allSkus.length}`);
      this.log(`成功: ${checkpoint.completed_skus.length}`);
      this.log(`未找到: ${checkpoint.not_found_skus.length}`);
      this.log(`失败: ${checkpoint.failed_skus.length}`);
      this.log(`输出: ${excelPath}`);
      this.log(`${'='.repeat(60)}`);

      this.sendFeishuMessage(`VEVOR crawl finished. Total: ${allSkus.length}, Success: ${checkpoint.completed_skus.length}, Not found: ${checkpoint.not_found_skus.length}, Failed: ${checkpoint.failed_skus.length}`, excelPath);

    } catch (e) {
      this.log(`\n[ERROR] Unexpected error: ${e.message}`);
      if (pendingResults.length > 0) {
        await this.flushExcel(workbook, excelPath, pendingResults);
        pendingResults.length = 0;
      }
      this.saveCheckpoint(checkpoint);
      throw e;
    } finally {
      this.doFlush = null;
      await browser.close();
    }
  }
}

async function run(config) {
  const crawler = new VevorCrawler(config);
  return crawler.run();
}

module.exports = { VevorCrawler, run, resolveBrowserPath, DEFAULT_CONFIG };
