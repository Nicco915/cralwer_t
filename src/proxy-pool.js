const fs = require('fs');
const path = require('path');

class ProxyPool {
  constructor(options) {
    this.client = options.client;
    this.machineIndex = Number(options.machineIndex || 0);
    this.machineTotal = Number(options.machineTotal || 1);
    this.channels = Number(options.channels || 1);
    this.assignmentsFile = options.assignmentsFile || path.resolve('./proxy-assignments.json');
    this.currentAssignments = {};
    this.proxyAuth = null;
  }

  async loadProxyAuth() {
    if (!this.client || this.proxyAuth) return;
    try {
      const auth = await this.client.getProxyAuthorization(1);
      if (auth && auth.username && auth.password) {
        this.proxyAuth = auth;
      }
    } catch (e) {
      // 白名单认证模式下该接口可能不可用或无需认证，继续按 ip:port 使用
    }
  }

  buildProxyUrl(ipPort) {
    if (!this.proxyAuth) return `http://${ipPort}`;
    const { username, password } = this.proxyAuth;
    return `http://${username}:${password}@${ipPort}`;
  }

  async loadProxies() {
    const all = await this.client.getKpsProxies();
    return all.filter((_, idx) => idx % this.machineTotal === this.machineIndex);
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
    await this.loadProxyAuth();
    const partitioned = await this.loadProxies();
    if (partitioned.length < this.channels) {
      throw new Error(
        `Proxy partition too small for machine ${this.machineIndex}: ` +
        `got ${partitioned.length} IPs but need ${this.channels} channels`
      );
    }

    const previous = this.loadAssignments();
    const assignments = {};
    const used = new Set();

    for (let i = 1; i <= this.channels; i++) {
      const channelId = `ch-${i}`;
      const previousIp = previous[channelId];
      if (previousIp && partitioned.includes(previousIp) && !used.has(previousIp)) {
        assignments[channelId] = previousIp;
        used.add(previousIp);
        continue;
      }
      const next = partitioned.find(ip => !used.has(ip));
      assignments[channelId] = next;
      used.add(next);
    }

    this.currentAssignments = assignments;
    this.saveAssignments(assignments);
    return Object.fromEntries(
      Object.entries(assignments).map(([id, ip]) => [id, this.buildProxyUrl(ip)])
    );
  }

  getProxyForChannel(channelId) {
    const ipPort = this.currentAssignments[channelId];
    if (!ipPort) return undefined;
    return this.buildProxyUrl(ipPort);
  }

  async refresh() {
    const previous = { ...this.currentAssignments };
    await this.assign();
    const changed = [];
    for (const channelId of Object.keys(this.currentAssignments)) {
      if (this.currentAssignments[channelId] !== previous[channelId]) {
        changed.push(channelId);
      }
    }
    return changed;
  }

  async nextForChannel(channelId) {
    const partitioned = await this.loadProxies();
    const current = this.currentAssignments[channelId];
    const idx = partitioned.indexOf(current);
    const next = partitioned[(idx + 1) % partitioned.length];
    this.currentAssignments[channelId] = next;
    this.saveAssignments(this.currentAssignments);
    return this.buildProxyUrl(next);
  }
}

module.exports = { ProxyPool };
