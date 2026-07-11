'use strict';

// VEVOR 各区域站的 canonical URL（公开事实，非密钥）。
// 空字符串 = 已知区域但无目标站（禁用），resolve 返回 null。
const BUILT_IN_REGIONS = {
  EU: 'https://eur.vevor.com',
  GB: 'https://www.vevor.co.uk',
  CA: 'https://www.vevor.ca',
  US: 'https://www.vevor.com',
  CN: '',
};

// 解析 'EU=https://eur.vevor.com,CN=' 形式的配置串：
// 无 '=' 的片段视为禁用码；空片段跳过；区域码统一大写。
function parseRegions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out[trimmed.toUpperCase()] = '';
      continue;
    }
    const code = trimmed.slice(0, eq).trim().toUpperCase();
    if (!code) continue;
    out[code] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

class RegionRegistry {
  constructor({ regions, defaultRegion = 'EU', legacyBaseUrl } = {}) {
    this.defaultRegion = String(defaultRegion || 'EU').trim().toUpperCase() || 'EU';
    const explicit = parseRegions(regions);
    this.map = { ...BUILT_IN_REGIONS, ...explicit };
    // 兼容旧的 CRAWLER_BASE_URL：单站点模式下该 URL = 默认区域的站点
    if (!(this.defaultRegion in explicit) && legacyBaseUrl) {
      this.map[this.defaultRegion] = legacyBaseUrl;
    }
  }

  // 缺省/空白 → 默认区域；其余 trim + upper 后原样返回
  normalize(code) {
    const c = String(code == null ? '' : code).trim().toUpperCase();
    return c === '' ? this.defaultRegion : c;
  }

  isKnown(code) {
    return Object.prototype.hasOwnProperty.call(this.map, this.normalize(code));
  }

  // 返回 baseUrl；未知码或禁用码（空 URL）返回 null
  resolve(code) {
    const c = this.normalize(code);
    if (!Object.prototype.hasOwnProperty.call(this.map, c)) return null;
    return this.map[c] || null;
  }
}

module.exports = { RegionRegistry, BUILT_IN_REGIONS, parseRegions };
