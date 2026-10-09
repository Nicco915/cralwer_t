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
    this.asn = options.asn || '';
    this.stickyMinutes = Number(options.stickyMinutes || 30);
    this.sessionPrefix = options.sessionPrefix || 'crawler';
    this.channels = Number(options.channels || 1);
    this.assignmentsFile = options.assignmentsFile || path.resolve('./cliproxy-assignments.json');
    this.rotationCooldownMs = Number(options.rotationCooldownMs || 5 * 60 * 1000);
    // 代理供应商对用户名参数命名不同：有的认 region/sid/t，当前供应商认 country/session/sticky
    this.regionParamName = options.regionParamName || 'country';
    this.asnParamName = options.asnParamName || 'asn';
    this.sessionParamName = options.sessionParamName || 'session';
    this.stickyParamName = options.stickyParamName || 'sticky';
    this.currentAssignments = {};
    this.nonces = {};
    this.lastRotation = {};
    // 可选日志回调（service 注入 this.log），缺省静默，保持容错语义
    this.log = typeof options.log === 'function' ? options.log : () => {};
  }

  generateNonce() {
    return crypto.randomBytes(4).toString('hex');
  }

  buildProxyUrl(channelId, nonce) {
    const sid = `${this.sessionPrefix}-${channelId.replace('ch-', 'ch')}-${nonce}`;
    let user = `${this.username}-${this.regionParamName}-${this.region}`;
    if (this.asn) {
      user += `-${this.asnParamName}-${this.asn}`;
    }
    user += `-${this.sessionParamName}-${sid}-${this.stickyParamName}-${this.stickyMinutes}`;
    return `http://${user}:${this.password}@${this.host}:${this.port}`;
  }

  loadAssignments() {
    try {
      const raw = fs.readFileSync(this.assignmentsFile, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      this.log(`[CLIPROXY] assignments 主文件读取/解析失败(${e.message})，尝试 .bak 备份`);
    }
    try {
      const raw = fs.readFileSync(this.assignmentsFile + '.bak', 'utf-8');
      const parsed = JSON.parse(raw);
      this.log('[CLIPROXY] assignments 已从 .bak 备份恢复');
      return parsed;
    } catch (e2) {
      this.log(`[CLIPROXY] assignments .bak 备份也不可用(${e2.code || e2.message})，回退为空 assignments`);
      return {};
    }
  }

  saveAssignments(assignments) {
    try {
      const dir = path.dirname(this.assignmentsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 原子写：先写 .tmp，替换前把旧文件留 .bak，最后 rename 原子替换，
      // 避免进程崩溃截断主文件导致下次 load 丢全部 nonce（集体换 IP）。
      const tmpFile = this.assignmentsFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(assignments, null, 2), 'utf-8');
      if (fs.existsSync(this.assignmentsFile)) {
        fs.copyFileSync(this.assignmentsFile, this.assignmentsFile + '.bak');
      }
      fs.renameSync(tmpFile, this.assignmentsFile);
    } catch (e) {
      this.log(`[CLIPROXY] assignments 写盘失败: ${e.message}`);
    }
  }

  extractNonceFromUrl(url) {
    try {
      const parsed = new URL(url);
      const user = parsed.username || '';
      const parts = user.split('-');
      const stickyIndex = parts.lastIndexOf(this.stickyParamName);
      if (stickyIndex > 0 && /^[a-f0-9]{8}$/.test(parts[stickyIndex - 1])) {
        return parts[stickyIndex - 1];
      }
    } catch (e) {
      // ignore invalid URL
    }
    return null;
  }

  async assign() {
    const previous = this.loadAssignments();
    const assignments = {};

    for (let i = 1; i <= this.channels; i++) {
      const channelId = `ch-${i}`;
      const previousUrl = previous[channelId];
      let nonce;

      if (previousUrl && typeof previousUrl === 'string') {
        nonce = this.extractNonceFromUrl(previousUrl) || this.generateNonce();
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

  async nextForChannel(channelId, options = {}) {
    const now = Date.now();
    const last = this.lastRotation[channelId] || 0;

    if (!options.force && now - last < this.rotationCooldownMs) {
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
