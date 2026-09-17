/* PHASE 6.3.10 — QUICK BULK PROXY parser (pure, no DOM/IPC). ONE LINE = ONE proxy; NEWLINE separates
 * profiles (mapped BY ORDER: line 1 → B1, line 2 → B2, …). Field separator INSIDE a line is "|":
 *   TYPE|host|port|username|password     (5 fields; username/password may be empty = no auth)
 *   TYPE|host|port                       (3 fields; no auth)
 * It produces the SAME proxy object the app already uses ({ protocol, host, port, username, password }) and
 * validates with the SAME rules as normalizeProxyConfig (protocol ∈ http/https/socks4/socks5, port 1..65535).
 * It NEVER stores, never talks IPC, and NEVER echoes a credential into an error. Dual-mode: window.BulkProxy
 * in the renderer + CommonJS for node tests. Applying is done by the renderer via the existing profileSetProxy. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BulkProxy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // The ONLY proxy schemes the build proves (mirrors proxy-config.cjs SUPPORTED_PROTOCOLS). No invented types.
  const SUPPORTED = Object.freeze(['http', 'https', 'socks4', 'socks5']);
  const TEMPLATE = 'HTTP|HOST|PORT|USERNAME|PASSWORD\nHTTP|HOST|PORT|USERNAME|PASSWORD\nSOCKS5|HOST|PORT|USERNAME|PASSWORD';
  const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
  // Empty string => no auth (null). A literal "0" (or any non-empty) is preserved verbatim.
  const optField = (v) => (v == null || v === '') ? null : String(v);
  function fail(line, field, message) { return { ok: false, error: { line, field, message } }; }

  // Parse the whole textarea. Trailing blank lines are ignored; a blank line BETWEEN proxies is an error.
  // Returns { ok:true, proxies:[{ protocol, host, port, username, password }] } or a typed error carrying the
  // exact 1-based line number + field — NEVER the credential.
  function parse(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop(); // drop trailing blank lines only
    const proxies = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i];
      if (line.trim() === '') return fail(lineNo, 'DÒNG', `Proxy dòng ${lineNo} trống.`);
      const parts = line.split('|').map((s) => s.trim());
      if (parts.length !== 3 && parts.length !== 5) {
        return fail(lineNo, 'SỐ TRƯỜNG', `Proxy dòng ${lineNo} sai định dạng: cần TYPE|host|port|user|pass.`);
      }
      const protocol = String(parts[0] || '').toLowerCase();
      if (!SUPPORTED.includes(protocol)) return fail(lineNo, 'TYPE', `Proxy dòng ${lineNo} không hợp lệ: TYPE.`);
      const host = parts[1];
      if (!host) return fail(lineNo, 'HOST', `Proxy dòng ${lineNo} không hợp lệ: HOST.`);
      const port = Number(parts[2]);
      if (!isPort(port)) return fail(lineNo, 'PORT', `Proxy dòng ${lineNo} không hợp lệ: PORT.`);
      const username = parts.length === 5 ? optField(parts[3]) : null;
      const password = parts.length === 5 ? optField(parts[4]) : null;
      proxies.push({ protocol, host, port, username, password });
    }
    return { ok: true, proxies };
  }

  // Map parsed proxies to profiles BY ORDER (§3). MORE proxies than profiles is rejected (§7); FEWER is fine
  // (the remaining profiles are left unchanged). Selection state NEVER affects the order — profile order wins.
  function mapToProfiles(proxies, profileIds) {
    const ids = Array.isArray(profileIds) ? profileIds : [];
    if (proxies.length > ids.length) {
      return { ok: false, error: { message: `Có ${proxies.length} proxy nhưng chỉ có ${ids.length} profile.` } };
    }
    return { ok: true, mapping: proxies.map((proxy, i) => ({ profileId: ids[i], proxy, index: i })) };
  }

  return { SUPPORTED, TEMPLATE, parse, mapToProfiles };
});
