'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Persists cookies to disk so a login survives reconnects on ANY CDP runtime
// (Chrome / WebView / WebView2 / CEF), where we cannot control the app's own
// profile. Cookies are stored raw (like all captured evidence) in userData.
function hostMatches(host, domain) {
  const d = String(domain || '').replace(/^\./, '');
  return !!d && (host === d || host.endsWith('.' + d));
}

class CookieVault {
  constructor(file) { this._file = file; this._byDomain = new Map(); this._load(); }
  _load() { try { const d = JSON.parse(fs.readFileSync(this._file, 'utf8')); for (const [k, v] of Object.entries(d || {})) this._byDomain.set(k, v); } catch { /* fresh */ } }
  _persist() { try { fs.mkdirSync(path.dirname(this._file), { recursive: true }); fs.writeFileSync(this._file, JSON.stringify(Object.fromEntries(this._byDomain)), 'utf8'); } catch { /* best effort */ } }

  // Merge a snapshot from Network.getAllCookies(); replace same name+path+domain.
  save(cookies) {
    let n = 0;
    for (const c of cookies || []) {
      const key = String(c.domain || '').replace(/^\./, ''); if (!key || !c.name) continue;
      const list = this._byDomain.get(key) || [];
      const rec = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite, expires: c.expires };
      const idx = list.findIndex((x) => x.name === c.name && x.path === rec.path);
      if (idx >= 0) list[idx] = rec; else list.push(rec);
      this._byDomain.set(key, list); n++;
    }
    if (n) this._persist();
    return n;
  }

  // Cookies applicable to a host, as Network.setCookies() params.
  paramsForHost(host) {
    const out = [];
    for (const [, list] of this._byDomain) for (const c of list) {
      if (!hostMatches(host, c.domain)) continue;
      const p = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (c.sameSite) p.sameSite = c.sameSite;
      if (typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires; // else keep as a session cookie
      out.push(p);
    }
    return out;
  }
  hasForHost(host) { for (const [, list] of this._byDomain) for (const c of list) if (hostMatches(host, c.domain)) return true; return false; }
}

module.exports = { CookieVault, hostMatches };
