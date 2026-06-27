const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CliproxyPool {
  constructor(options) {
    this.host = options.host;
    this.port = Number(options.port);
    this.username = options.username;
    this.password = options.password;
    this.region = options.region || 'EU';
    this.stickyMinutes = Number(options.stickyMinutes || 30);
    this.sessionPrefix = options.sessionPrefix || 'crawler';
    this.channels = Number(options.channels || 1);
    this.assignmentsFile = options.assignmentsFile || path.resolve('./cliproxy-assignments.json');
    this.rotationCooldownMs = Number(options.rotationCooldownMs || 5 * 60 * 1000);
    this.currentAssignments = {};
    this.nonces = {};
    this.lastRotation = {};
  }

  generateNonce() {
    return crypto.randomBytes(4).toString('hex');
  }

  buildProxyUrl(channelId, nonce) {
    const sid = `${this.sessionPrefix}-${channelId.replace('ch-', 'ch')}-${nonce}`;
    const user = `${this.username}-region-${this.region}-sid-${sid}-t-${this.stickyMinutes}`;
    return `http://${user}:${this.password}@${this.host}:${this.port}`;
  }

  loadAssignments() {
    try {
      const raw = fs.readFileSync(this.assignmentsFile, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }

  saveAssignments(assignments) {
    const dir = path.dirname(this.assignmentsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.assignmentsFile, JSON.stringify(assignments, null, 2), 'utf-8');
  }

  async assign() {
    const previous = this.loadAssignments();
    const assignments = {};

    for (let i = 1; i <= this.channels; i++) {
      const channelId = `ch-${i}`;
      const previousUrl = previous[channelId];
      let nonce;

      if (previousUrl && typeof previousUrl === 'string') {
        const match = previousUrl.match(/sid-.+-([a-f0-9]{8})-t-/);
        nonce = match ? match[1] : this.generateNonce();
      } else {
        nonce = this.generateNonce();
      }

      assignments[channelId] = this.buildProxyUrl(channelId, nonce);
      this.nonces[channelId] = nonce;
    }

    this.currentAssignments = assignments;
    this.saveAssignments(assignments);
    return assignments;
  }

  getProxyForChannel(channelId) {
    return this.currentAssignments[channelId];
  }

  async nextForChannel(channelId) {
    const now = Date.now();
    const last = this.lastRotation[channelId] || 0;

    if (now - last < this.rotationCooldownMs) {
      return this.currentAssignments[channelId];
    }

    const nonce = this.generateNonce();
    this.nonces[channelId] = nonce;
    this.lastRotation[channelId] = now;
    const url = this.buildProxyUrl(channelId, nonce);
    this.currentAssignments[channelId] = url;
    this.saveAssignments(this.currentAssignments);
    return url;
  }

  async refresh() {
    return this.assign();
  }
}

module.exports = { CliproxyPool };
