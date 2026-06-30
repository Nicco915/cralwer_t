const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('../src/cli');
const { ImageUploader } = require('../src/image-uploader');
const { startMockUploadServer } = require('../src/mock-upload-server');

function parseTransferArgs(argv) {
  const args = (argv || []).filter((a) => a !== undefined && a !== null);
  const paths = [];
  const seen = new Set();
  const options = {
    uploadUrl: undefined,
    uploadConcurrency: undefined,
    uploadRetries: undefined,
    nodeCode: undefined,
    nodeToken: undefined,
    mockUpload: false,
    progress: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const rawKey = eqIndex !== -1 ? arg.slice(2, eqIndex) : arg.slice(2);
      const rawVal = eqIndex !== -1 ? arg.slice(eqIndex + 1) : (() => {
        const next = args[i + 1];
        if (next !== undefined && !String(next).startsWith('--')) { i++; return next; }
        return true;
      })();
      switch (rawKey) {
        case 'upload-url': options.uploadUrl = rawVal; break;
        case 'upload-concurrency': options.uploadConcurrency = Number(rawVal); break;
        case 'upload-retries': options.uploadRetries = Number(rawVal); break;
        case 'node-code': options.nodeCode = rawVal; break;
        case 'node-token': options.nodeToken = rawVal; break;
        case 'mock-upload': options.mockUpload = true; break;
        case 'no-progress': options.progress = false; break;
        default: break;
      }
    } else {
      if (!seen.has(arg)) { seen.add(arg); paths.push(arg); }
    }
  }

  return { paths, options };
}

module.exports = { parseTransferArgs };