#!/usr/bin/env node
const path = require('path');
const { loadEnvFile, parse } = require('../src/cli');
const { run } = require('../src/crawler');

loadEnvFile(process.cwd());

const defaults = {
  flushInterval: 3,
  testCount: 10,
};

const config = parse(process.argv.slice(2), defaults);

// Apply test-mode naming defaults only if the caller did not explicitly override them.
if (!process.argv.slice(2).some(arg => arg.startsWith('--result') || arg.startsWith('--result='))) {
  config.resultPath = path.join(config.outputDir || './output', 'vevor_result_test.xlsx');
}
if (!process.argv.slice(2).some(arg => arg.startsWith('--checkpoint') || arg.startsWith('--checkpoint='))) {
  config.checkpointFile = path.join(config.outputDir || './output', 'checkpoint_test.json');
}

run(config).catch((err) => {
  console.error(err);
  process.exit(1);
});
