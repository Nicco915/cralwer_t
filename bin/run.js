#!/usr/bin/env node
const path = require('path');
const os = require('os');
const { loadEnvFile, parse } = require('../src/cli');
const { run } = require('../src/crawler');
const { runService } = require('../src/service');

function buildServiceConfig(config) {
  return {
    baseUrl: config.baseUrl || 'https://eur.vevor.com',
    imageDir: config.imageDir || path.resolve('./output/images'),
    userAgent: config.userAgent,
    viewport: config.viewport,
    locale: config.locale,
    timezone: config.timezone,
    browserPath: config.browserPath,
    headless: config.headless !== false,
    maxImages: config.maxImages !== undefined ? Number(config.maxImages) : 5,
    cloudflareMaxWait: config.cloudflareMaxWait !== undefined ? Number(config.cloudflareMaxWait) : 45,
    minDelay: config.minDelay !== undefined ? Number(config.minDelay) : 5,
    maxDelay: config.maxDelay !== undefined ? Number(config.maxDelay) : 10,
    nodeCode: config.nodeCode || os.hostname(),
    nodeToken: config.nodeToken || '',
    taskUrl: config.taskUrl || 'http://117.72.52.0/renren-api/classify/open/crawler/tasks',
    callbackUrl: config.callbackUrl || 'http://117.72.52.0/renren-api/classify/open/crawler/callback',
    channels: config.channels !== undefined ? Number(config.channels) : 4,
    pollInterval: config.pollInterval !== undefined ? Number(config.pollInterval) : 5000,
    pollLimit: config.pollLimit !== undefined ? Number(config.pollLimit) : 10,
    pushRetries: config.pushRetries !== undefined ? Number(config.pushRetries) : 3,
    proxy: config.proxy,
  };
}

function main() {
  loadEnvFile(process.cwd());

  const config = parse(process.argv.slice(2));

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
