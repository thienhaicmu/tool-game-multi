'use strict';

// ---------------------------------------------------------------------------
// PURE proxy configuration: normalize / validate / redact one ProxyConfig, and
// derive the CREDENTIAL-FREE Chromium `--proxy-server` value. This module never
// touches disk, never launches Chrome and never holds a password in a public
// snapshot — the secret lives only behind `passwordSecretRef` (proxy-secret-store).
//
// Chromium proxy scheme support that this build proves: http, https, socks4,
// socks5. We refuse to CLAIM any other scheme so a user can never silently get a
// direct connection from an unsupported value.
// ---------------------------------------------------------------------------

const SUPPORTED_PROTOCOLS = Object.freeze(['http', 'https', 'socks4', 'socks5']);
// Chromium's --proxy-server scheme tokens per protocol (socks5 -> "socks5").
const CHROME_SCHEME = Object.freeze({ http: 'http', https: 'https', socks4: 'socks4', socks5: 'socks5' });

function typedError(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }

function isPort(p) { return Number.isInteger(p) && p >= 1 && p <= 65535; }

// Parse the convenience input formats (§2):
//   host:port
//   host:port:username:password
//   protocol://host:port
//   protocol://username:password@host:port
// Returns { ok, parts } with credentials separated so the caller routes the password
// into secure storage — never the URL. Never throws.
function parseFlexibleProxy(raw, defaultProtocol = 'http') {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return typedError('PROXY_FORMAT_INVALID', 'Empty proxy value');
  if (text.includes('://') || text.includes('@')) return parseProxyUrl(text);
  // No scheme/userinfo: treat as colon-separated host:port[:user:pass].
  const segs = text.split(':');
  if (segs.length === 2) return { ok: true, parts: { protocol: defaultProtocol, host: segs[0], port: Number(segs[1]), username: '', password: '' } };
  if (segs.length === 4) return { ok: true, parts: { protocol: defaultProtocol, host: segs[0], port: Number(segs[1]), username: segs[2], password: segs[3] } };
  return parseProxyUrl(text); // fall through (may still be host:port with weird chars)
}

// Parse a proxy URL like "socks5://user:pass@host:1080". Returns credential parts
// SEPARATELY so the caller routes the password into secure storage — never the URL.
function parseProxyUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return typedError('PROXY_FORMAT_INVALID', 'Empty proxy value');
  let u;
  try { u = new URL(text.includes('://') ? text : `http://${text}`); } catch { return typedError('PROXY_FORMAT_INVALID', 'Proxy value is not a valid URL'); }
  const protocol = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.hostname;
  const port = u.port ? Number(u.port) : null;
  const username = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  if (!host) return typedError('PROXY_FORMAT_INVALID', 'Proxy host is missing');
  return { ok: true, parts: { protocol, host, port, username, password } };
}

/**
 * normalizeProxyConfig(input) -> { ok, config } | { ok:false, error }
 * Produces a persistable ProxyConfig with NO plaintext password (only a secretRef).
 * The plaintext password (if any) is returned separately as `secret` so the caller
 * stores it via proxy-secret-store and never writes it to the config store.
 */
function normalizeProxyConfig(input = {}) {
  const src = { ...input };
  // Allow a single raw string (any of the convenience formats) OR a url field to
  // populate protocol/host/port/creds. Password is separated out, never persisted raw.
  if (src.input && !src.url) {
    const parsed = parseFlexibleProxy(src.input, src.protocol || 'http');
    if (!parsed.ok) return parsed;
    const p = parsed.parts;
    if (src.protocol == null) src.protocol = p.protocol;
    if (src.host == null) src.host = p.host;
    if (src.port == null) src.port = p.port;
    if (src.username == null && p.username) src.username = p.username;
    if (src.password == null && p.password) src.password = p.password;
  }
  if (src.url) {
    const parsed = parseProxyUrl(src.url);
    if (!parsed.ok) return parsed;
    const p = parsed.parts;
    if (src.protocol == null) src.protocol = p.protocol;
    if (src.host == null) src.host = p.host;
    if (src.port == null) src.port = p.port;
    if (src.username == null && p.username) src.username = p.username;
    if (src.password == null && p.password) src.password = p.password;
  }
  const protocol = String(src.protocol || '').toLowerCase();
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    return typedError('PROXY_PROTOCOL_UNSUPPORTED', `Unsupported proxy protocol: ${protocol || '(none)'}`, { supported: SUPPORTED_PROTOCOLS });
  }
  const host = String(src.host || '').trim();
  if (!host) return typedError('PROXY_FORMAT_INVALID', 'Proxy host is required');
  const port = Number(src.port);
  if (!isPort(port)) return typedError('PROXY_FORMAT_INVALID', 'Proxy port must be an integer 1..65535');

  const username = src.username != null ? String(src.username) : '';
  const hasPassword = src.password != null && String(src.password).length > 0;
  const id = src.id != null ? String(src.id) : `PX-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const passwordSecretRef = hasPassword || src.passwordSecretRef ? (src.passwordSecretRef || `proxy:${id}`) : null;

  const bypassList = Array.isArray(src.bypassList)
    ? src.bypassList.map((s) => String(s).trim()).filter(Boolean)
    : (typeof src.bypassList === 'string' && src.bypassList.trim() ? src.bypassList.split(',').map((s) => s.trim()).filter(Boolean) : []);

  const config = {
    id,
    label: src.label != null ? String(src.label) : `${protocol}://${host}:${port}`,
    protocol,
    host,
    port,
    username: username || null,
    passwordSecretRef,           // reference only — NEVER the password itself
    bypassList,
    enabled: src.enabled !== false,
    proxyRequired: src.proxyRequired !== false, // §6 default: a configured proxy is mandatory (no direct fallback)
  };
  return { ok: true, config, secret: hasPassword ? String(src.password) : null };
}

// The CREDENTIAL-FREE Chromium proxy args. Username/password are NEVER placed on
// the command line (§4) — they are answered later via the CDP auth seam.
function toChromeArgs(config) {
  if (!config) return [];
  const scheme = CHROME_SCHEME[config.protocol];
  if (!scheme) return [];
  const args = [`--proxy-server=${scheme}://${config.host}:${config.port}`];
  if (Array.isArray(config.bypassList) && config.bypassList.length) {
    args.push(`--proxy-bypass-list=${config.bypassList.join(';')}`);
  }
  return args;
}

// The credential-free descriptor threaded onto a BrowserRun for the launcher.
function toRunProxy(config) {
  if (!config) return null;
  return { id: config.id, protocol: config.protocol, host: config.host, port: config.port, bypassList: config.bypassList || [], requiresAuth: !!config.passwordSecretRef };
}

// Redaction-safe public snapshot: label/protocol/endpoint + auth presence, NEVER a
// password and never a username:password@ endpoint.
function publicSnapshot(config) {
  if (!config) return null;
  return {
    id: config.id,
    label: config.label,
    protocol: config.protocol,
    endpoint: `${config.host}:${config.port}`,
    host: config.host,
    port: config.port,
    hasAuth: !!config.passwordSecretRef,
    username: config.username ? maskUser(config.username) : null,
    bypassList: config.bypassList || [],
    enabled: config.enabled,
    proxyRequired: config.proxyRequired,
  };
}

function maskUser(u) {
  const s = String(u);
  if (s.length <= 2) return '*'.repeat(s.length);
  return s[0] + '*'.repeat(Math.max(1, s.length - 2)) + s[s.length - 1];
}

// PROXY-OPTIONAL launch gate. Proxy is OPTIONAL: a slot with NO proxyRef runs in
// DIRECT mode (a valid state, not an error). The presence of a proxyRef is the intent
// to use THAT proxy — so when a ref IS assigned it must resolve and be enabled, and a
// missing/unknown/disabled proxy is a TYPED failure that BLOCKS the launch: it is NEVER
// silently replaced by a direct connection (§7). `proxyRequired:true` is kept as an
// explicit opt-IN gate for callers that demand a proxy even when none is bound.
function resolveLaunchProxy(profileConfig = {}, getConfig) {
  const ref = profileConfig.proxyRef || null;
  const proxyRequired = profileConfig.proxyRequired === true; // opt-in; default = optional
  if (!ref) {
    if (proxyRequired) return typedError('PROXY_CONFIG_REQUIRED', 'This profile requires a proxy but none is assigned');
    return { ok: true, runProxy: null, mode: 'DIRECT' }; // no proxy => DIRECT is valid
  }
  // A proxyRef is present => use THAT proxy. Never silently fall back to Direct (§7).
  const config = typeof getConfig === 'function' ? getConfig(ref) : null;
  if (!config) return typedError('PROXY_CONFIG_NOT_FOUND', `Proxy configuration not found: ${ref}`, { proxyRef: ref });
  if (config.enabled === false) return typedError('PROXY_CONFIG_DISABLED', 'Assigned proxy is disabled; launch blocked (no direct fallback)', { proxyRef: ref });
  return { ok: true, runProxy: toRunProxy(config), config, mode: 'PROXY' };
}

module.exports = {
  SUPPORTED_PROTOCOLS, CHROME_SCHEME,
  parseProxyUrl, parseFlexibleProxy, normalizeProxyConfig, toChromeArgs, toRunProxy, publicSnapshot, resolveLaunchProxy,
};
