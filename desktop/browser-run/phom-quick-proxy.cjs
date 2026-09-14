'use strict';

const { SUPPORTED_PROTOCOLS } = require('./proxy-config.cjs');

// ---------------------------------------------------------------------------
// PURE quick-3-proxy parser (§4/§5). Turns the "THIẾT LẬP NHANH 3 PROXY" textarea
// (three lines, one per slot A/B/C) + the authoritative protocol selector into three
// normalized proxy descriptors. No disk, no network, no Electron — deterministically
// unit-testable and NEVER placed in the renderer as the authority.
//
// Supported per-line formats:
//   host|port                              (pipe — primary)
//   host|port|username|password            (pipe with auth)
//   host:port                              (colon)
//   host:port:username:password            (colon with auth)
//   protocol://host:port                   (URL — protocol EXPLICIT)
//   protocol://username:password@host:port (URL with auth — protocol EXPLICIT)
// Optional slot prefix (order-independent): "A=", "B=", "C=".
//
// Protocol policy: the selector protocol is AUTHORITATIVE when a line carries no
// scheme. If a line DOES carry a scheme and it differs from the selector, that is a
// hard PHOM_PROXY_PROTOCOL_CONFLICT — the protocol is never silently overwritten.
//
// Secret policy: a password is carried through verbatim (including "0" and empty),
// but is NEVER echoed into any error message. Empty username/password become null
// (no auth) while a literal "0" is preserved.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);
const PROTOCOLS = new Set(SUPPORTED_PROTOCOLS); // http, https, socks4, socks5

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function isPort(p) { return Number.isInteger(p) && p >= 1 && p <= 65535; }
// Empty string => no auth (null); a literal "0" (or any other non-empty) is preserved.
function optField(v) { return (v == null || v === '') ? null : String(v); }

// Parse ONE line BODY (prefix already stripped) into raw parts. Returns
// { protocol, protocolExplicit, host, port, username, password } or a typed error.
// `slot`/`line` are attached to errors for the caller; NEVER the credential.
function parseLineBody(body, slot, lineNo) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return err('PHOM_PROXY_FORMAT_INVALID', `Dòng ${lineNo} rỗng`, { slot, line: lineNo });

  // URL form (explicit scheme / userinfo).
  if (text.includes('://') || text.includes('@')) {
    let u;
    try { u = new URL(text.includes('://') ? text : `http://${text}`); } catch { return err('PHOM_PROXY_FORMAT_INVALID', `Dòng ${lineNo} không phải URL proxy hợp lệ`, { slot, line: lineNo }); }
    const protocol = u.protocol.replace(/:$/, '').toLowerCase();
    return {
      ok: true,
      protocol,
      protocolExplicit: text.includes('://'),
      host: u.hostname,
      port: u.port ? Number(u.port) : NaN,
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
    };
  }

  // Pipe form (primary). Only 2 (host|port) or 4 (host|port|user|pass) fields — a
  // password containing "|" is NOT supported here (use the URL form with encoding).
  if (text.includes('|')) {
    const parts = text.split('|');
    if (parts.length !== 2 && parts.length !== 4) return err('PHOM_PROXY_FORMAT_INVALID', `Dòng ${lineNo} sai định dạng host|port hoặc host|port|user|pass`, { slot, line: lineNo });
    return { ok: true, protocol: null, protocolExplicit: false, host: parts[0].trim(), port: Number(parts[1].trim()), username: parts[2] != null ? parts[2] : '', password: parts[3] != null ? parts[3] : '' };
  }

  // Colon form: host:port or host:port:user:pass.
  const segs = text.split(':');
  if (segs.length === 2) return { ok: true, protocol: null, protocolExplicit: false, host: segs[0].trim(), port: Number(segs[1].trim()), username: '', password: '' };
  if (segs.length === 4) return { ok: true, protocol: null, protocolExplicit: false, host: segs[0].trim(), port: Number(segs[1].trim()), username: segs[2], password: segs[3] };
  return err('PHOM_PROXY_FORMAT_INVALID', `Dòng ${lineNo} sai định dạng`, { slot, line: lineNo });
}

// Assign each non-empty line to a slot. Prefix mode (any "A="/"B="/"C=") is
// order-independent and must cover A/B/C exactly once; otherwise positional 1→A/2→B/3→C.
// Returns { ok, bySlot: { A:{body,line}, ... } } | typed error.
function assignSlots(lines) {
  const effective = [];
  lines.forEach((raw, i) => { const t = String(raw).trim(); if (t) effective.push({ text: t, line: i + 1 }); });
  if (!effective.length) return err('PHOM_PROXY_QUICK_INPUT_REQUIRED', 'Chưa nhập proxy nào');

  const prefixRe = /^([ABCabc])\s*=\s*(.*)$/;
  const anyPrefixed = effective.some((e) => prefixRe.test(e.text));

  if (anyPrefixed) {
    const bySlot = {};
    for (const e of effective) {
      const m = prefixRe.exec(e.text);
      if (!m) return err('PHOM_PROXY_FORMAT_INVALID', `Dòng ${e.line} thiếu tiền tố slot (A=/B=/C=)`, { line: e.line });
      const slot = m[1].toUpperCase();
      if (bySlot[slot]) return err('PHOM_PROXY_SLOT_DUPLICATED', `Slot ${slot} bị lặp`, { slot });
      bySlot[slot] = { body: m[2].trim(), line: e.line };
    }
    for (const s of SLOTS) if (!bySlot[s]) return err('PHOM_PROXY_SLOT_MISSING', `Thiếu slot ${s}`, { slot: s });
    return { ok: true, bySlot };
  }

  // Positional: exactly three effective lines.
  if (effective.length !== 3) return err('PHOM_PROXY_QUICK_LINE_COUNT_INVALID', `Cần đúng 3 dòng proxy (đang có ${effective.length})`, { count: effective.length });
  return { ok: true, bySlot: { A: { body: effective[0].text, line: effective[0].line }, B: { body: effective[1].text, line: effective[1].line }, C: { body: effective[2].text, line: effective[2].line } } };
}

/**
 * parseQuickProxies(text, { protocol }) -> { ok, slots: { A, B, C } } | typed error.
 * Each slot value: { slot, protocol, host, port, username?, password? }. The selector
 * `protocol` is authoritative when a line has no scheme; a conflicting scheme is a
 * typed error. Never throws; never leaks a credential into an error message.
 */
function parseQuickProxies(text, { protocol } = {}) {
  const selector = String(protocol || '').toLowerCase();
  if (!PROTOCOLS.has(selector)) return err('PHOM_PROXY_PROTOCOL_INVALID', `Loại proxy không hợp lệ: ${selector || '(trống)'}`, { supported: [...PROTOCOLS] });
  if (text == null || String(text).trim() === '') return err('PHOM_PROXY_QUICK_INPUT_REQUIRED', 'Chưa nhập proxy nào');

  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const assigned = assignSlots(lines);
  if (!assigned.ok) return assigned;

  const slots = {};
  for (const s of SLOTS) {
    const { body, line } = assigned.bySlot[s];
    const parsed = parseLineBody(body, s, line);
    if (!parsed.ok) return parsed;

    // Protocol resolution: selector is authoritative unless the line is explicit.
    let proto = selector;
    if (parsed.protocolExplicit) {
      const lineProto = String(parsed.protocol || '').toLowerCase();
      if (!PROTOCOLS.has(lineProto)) return err('PHOM_PROXY_PROTOCOL_INVALID', `Slot ${s}: protocol không hỗ trợ (${lineProto || '(trống)'})`, { slot: s, line, supported: [...PROTOCOLS] });
      if (lineProto !== selector) return err('PHOM_PROXY_PROTOCOL_CONFLICT', `Slot ${s}: protocol trong dòng (${lineProto}) khác với loại đã chọn (${selector})`, { slot: s, line, lineProtocol: lineProto, selector });
      proto = lineProto;
    }

    const host = String(parsed.host || '').trim();
    if (!host) return err('PHOM_PROXY_HOST_REQUIRED', `Slot ${s}: thiếu host`, { slot: s, line });
    const port = Number(parsed.port);
    if (!isPort(port)) return err('PHOM_PROXY_PORT_INVALID', `Slot ${s}: port phải là số nguyên 1..65535`, { slot: s, line });

    const username = optField(parsed.username);
    const password = optField(parsed.password);
    const slotOut = { slot: s, protocol: proto, host, port };
    if (username != null) slotOut.username = username;
    if (password != null) slotOut.password = password;
    slots[s] = slotOut;
  }
  return { ok: true, slots };
}

/**
 * parseQuickProxyRows(rows) -> { ok, slots: { A, B, C } } | typed error.
 * The NEW UI sends three slot-labeled rows [{ slot, protocol, value }] — the slot is
 * authoritative from the row label, so NO A=/B=/C= prefix is needed. Each row carries
 * its OWN protocol selector. Reuses parseLineBody + the same protocol/host/port rules
 * as the textarea path (single source of truth). Never leaks a credential.
 */
function parseQuickProxyRows(rows, { partial = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return err('PHOM_PROXY_QUICK_INPUT_REQUIRED', 'Chưa nhập proxy nào');
  const bySlot = {};
  for (const raw of rows) {
    const slot = String(raw && raw.slot || '').toUpperCase();
    if (!SLOTS.includes(slot)) return err('PHOM_PROXY_FORMAT_INVALID', `Slot không hợp lệ: ${slot || '(trống)'}`);
    if (bySlot[slot]) return err('PHOM_PROXY_SLOT_DUPLICATED', `Slot ${slot} bị lặp`, { slot });
    // In PARTIAL mode (proxy optional, §10) a blank value means "leave this slot as-is":
    // skip it rather than fail. In strict mode an empty value still errors in parseLineBody.
    if (partial && (raw.value == null || String(raw.value).trim() === '')) continue;
    bySlot[slot] = raw;
  }
  // Strict mode requires all three slots; partial mode requires at least one input row.
  if (!partial) { for (const s of SLOTS) if (!bySlot[s]) return err('PHOM_PROXY_SLOT_MISSING', `Thiếu slot ${s}`, { slot: s }); }
  else if (!Object.keys(bySlot).length) return err('PHOM_PROXY_QUICK_INPUT_REQUIRED', 'Nhập proxy cho ít nhất một slot');

  const targetSlots = SLOTS.filter((s) => bySlot[s]);
  const slots = {};
  for (const s of targetSlots) {
    const row = bySlot[s];
    const selector = String(row.protocol || '').toLowerCase();
    if (!PROTOCOLS.has(selector)) return err('PHOM_PROXY_PROTOCOL_INVALID', `Slot ${s}: loại proxy không hợp lệ`, { slot: s, supported: [...PROTOCOLS] });
    const parsed = parseLineBody(row.value, s, s);
    if (!parsed.ok) return parsed;
    let proto = selector;
    if (parsed.protocolExplicit) {
      const lineProto = String(parsed.protocol || '').toLowerCase();
      if (!PROTOCOLS.has(lineProto)) return err('PHOM_PROXY_PROTOCOL_INVALID', `Slot ${s}: protocol không hỗ trợ`, { slot: s, supported: [...PROTOCOLS] });
      if (lineProto !== selector) return err('PHOM_PROXY_PROTOCOL_CONFLICT', `Slot ${s}: protocol trong chuỗi (${lineProto}) khác loại đã chọn (${selector})`, { slot: s, lineProtocol: lineProto, selector });
      proto = lineProto;
    }
    const host = String(parsed.host || '').trim();
    if (!host) return err('PHOM_PROXY_HOST_REQUIRED', `Slot ${s}: thiếu host`, { slot: s });
    const port = Number(parsed.port);
    if (!isPort(port)) return err('PHOM_PROXY_PORT_INVALID', `Slot ${s}: port phải là số nguyên 1..65535`, { slot: s });
    const username = optField(parsed.username);
    const password = optField(parsed.password);
    const slotOut = { slot: s, protocol: proto, host, port };
    if (username != null) slotOut.username = username;
    if (password != null) slotOut.password = password;
    slots[s] = slotOut;
  }
  return { ok: true, slots };
}

module.exports = { SLOTS, parseQuickProxies, parseQuickProxyRows, parseLineBody, assignSlots };
