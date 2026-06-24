const path = require('node:path');
const fs = require('node:fs');

const STATE_FILE = '.deployment-state.json';

function getStatePath(installDir) {
  return path.join(installDir, STATE_FILE);
}

function readState(installDir) {
  const filePath = getStatePath(installDir);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { current: null, previous: null, history: [] };
    }
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

function writeState(installDir, state) {
  const filePath = getStatePath(installDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

function recordCurrent(installDir, commit) {
  const state = readState(installDir);
  state.previous = state.current;
  state.current = commit;
  state.history = [commit, ...state.history].slice(0, 20);
  writeState(installDir, state);
}

module.exports = {
  STATE_FILE,
  getStatePath,
  readState,
  writeState,
  recordCurrent,
};
