#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnvFile, parse } = require('../src/cli');
const { run } = require('../src/crawler');
const { runService } = require('../src/service');

function buildServiceConfig(config) {
  return {
    baseUrl: config.baseUrl || 'https://eur.vevor.com',
    imageDir: config.imageDir || path.resolve('./output/images'),
    stealthMode: config.stealthMode ?? 'channel',
    userAgent: config.userAgent,
    viewport: config.viewport,
    locale: config.locale,
    timezone: config.timezone,
    browserPath: config.browserPath,
    browserTempDir: config.browserTempDir,
    headless: config.headless !== false,
    maxImages: config.maxImages !== undefined ? Number(config.maxImages) : 5,
    cloudflareMaxWait: config.cloudflareMaxWait !== undefined ? Number(config.cloudflareMaxWait) : 45,
    minDelay: config.minDelay !== undefined ? Number(config.minDelay) : 5,
    maxDelay: config.maxDelay !== undefined ? Number(config.maxDelay) : 10,
    nodeCode: config.nodeCode || os.hostname(),
    nodeToken: config.nodeToken || '',
    healthPort: (() => {
      if (config.healthPort === undefined || config.healthPort === '') return undefined;
      const n = Number(config.healthPort);
      return Number.isNaN(n) ? undefined : n;
    })(),
    taskUrl: config.taskUrl || 'http://117.72.52.0/renren-api/classify/open/crawler/tasks',
    callbackUrl: config.callbackUrl || 'http://117.72.52.0/renren-api/classify/open/crawler/callback',
    channels: config.channels !== undefined ? Number(config.channels) : 4,
    pollInterval: config.pollInterval !== undefined ? Number(config.pollInterval) : 5000,
    pollLimit: config.pollLimit !== undefined ? Number(config.pollLimit) : 10,
    pushRetries: config.pushRetries !== undefined ? Number(config.pushRetries) : 3,
    gotoMaxRetries: config.gotoMaxRetries !== undefined ? Number(config.gotoMaxRetries) : 3,
    gotoTimeout: config.gotoTimeout !== undefined ? Number(config.gotoTimeout) : 30000,
    gotoRetryDelays: config.gotoRetryDelays || [3000, 6000, 12000],
    headedFallback: config.headedFallback !== false && config.headedFallback !== 'false' && config.headedFallback !== '',
    pageRefreshAfterTasks: config.pageRefreshAfterTasks !== undefined ? Number(config.pageRefreshAfterTasks) : 20,
    dataLayerMaxRetries: config.dataLayerMaxRetries !== undefined ? Number(config.dataLayerMaxRetries) : 1,
    dataLayerFailureThreshold: config.dataLayerFailureThreshold !== undefined ? Number(config.dataLayerFailureThreshold) : 3,
    proxy: config.proxy,
    kuaidailiSecretId: config.kuaidailiSecretId,
    kuaidailiSecretKey: config.kuaidailiSecretKey,
    kuaidailiProxyType: config.kuaidailiProxyType || 'kps',
    kuaidailiProxyNum: config.kuaidailiProxyNum !== undefined ? Number(config.kuaidailiProxyNum) : 1000,
    kuaidailiTokenCacheFile: config.kuaidailiTokenCacheFile || '.kdl_token',
    proxyMachineIndex: config.proxyMachineIndex !== undefined ? Number(config.proxyMachineIndex) : 0,
    proxyMachineTotal: config.proxyMachineTotal !== undefined ? Number(config.proxyMachineTotal) : 1,
    proxyRefreshIntervalMs: config.proxyRefreshIntervalMs !== undefined ? Number(config.proxyRefreshIntervalMs) : 300000,
    proxyAssignmentsFile: config.proxyAssignmentsFile || path.resolve('./proxy-assignments.json'),
    cliproxyHost: config.cliproxyHost,
    cliproxyPort: config.cliproxyPort !== undefined ? Number(config.cliproxyPort) : 1080,
    cliproxyUsername: config.cliproxyUsername,
    cliproxyPassword: config.cliproxyPassword,
    cliproxyRegion: config.cliproxyRegion || 'EU',
    cliproxyStickyMinutes: config.cliproxyStickyMinutes !== undefined ? Number(config.cliproxyStickyMinutes) : 30,
    cliproxySessionPrefix: config.cliproxySessionPrefix,
    cliproxyAssignmentsFile: config.cliproxyAssignmentsFile || path.resolve('./cliproxy-assignments.json'),
    cliproxyRegionParamName: config.cliproxyRegionParamName || 'country',
    cliproxySessionParamName: config.cliproxySessionParamName || 'session',
    cliproxyStickyParamName: config.cliproxyStickyParamName || 'sticky',
    imageUploadUrl: config.imageUploadUrl || '',
    imageUploadConcurrency: config.imageUploadConcurrency !== undefined ? Number(config.imageUploadConcurrency) : 2,
    imageUploadRetries: config.imageUploadRetries !== undefined ? Number(config.imageUploadRetries) : 3,
  };
}

function main() {
  loadEnvFile(process.cwd());

  const config = parse(process.argv.slice(2));

  // 强制 Playwright 使用项目目录作为临时目录，避免系统 Temp 权限/锁定问题
  const browserTempDir = config.browserTempDir || path.resolve(process.cwd(), 'output', 'browser-temp');
  if (!fs.existsSync(browserTempDir)) {
    fs.mkdirSync(browserTempDir, { recursive: true });
  }
  process.env.TEMP = browserTempDir;
  process.env.TMP = browserTempDir;
  if (process.env.TMPDIR !== undefined) {
    process.env.TMPDIR = browserTempDir;
  }

  if (config.mode === 'service') {
    const serviceConfig = buildServiceConfig(config);

    runService(serviceConfig).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    run(config).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildServiceConfig };
