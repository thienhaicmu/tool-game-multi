'use strict';

// ---------------------------------------------------------------------------
// ProxyTester — resolves a profile's observed public IP THROUGH its proxy, using a
// configured, allowlisted IP-check endpoint (§7). It never calls the game endpoint,
// never sends game credentials/cookies/tokens, and NEVER falls back to a direct
// connection on failure. The actual transport is injected so the state machine,
// allowlist enforcement, timeout and cancellation are all unit-testable; main.cjs
// supplies a real proxy-capable transport.
// ---------------------------------------------------------------------------

const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_TESTED: 'NOT_TESTED',
  TESTING: 'TESTING',
  PASS: 'PASS',
  FAILED: 'FAILED',
  AUTH_FAILED: 'AUTH_FAILED',
  TIMEOUT: 'TIMEOUT',
});

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }

class ProxyTester {
  constructor(deps = {}) {
    // transport({ proxy, url, timeoutMs, signal }) -> { ok:true, ip } | { ok:false, error:{code} }
    this._transport = typeof deps.transport === 'function' ? deps.transport : null;
    this._allowlist = (Array.isArray(deps.allowlist) ? deps.allowlist : []).map((h) => String(h).toLowerCase()).filter(Boolean);
    this._ipCheckUrl = deps.ipCheckUrl || null;
    this._timeoutMs = deps.timeoutMs != null ? deps.timeoutMs : 8000;
    this._now = deps.now || (() => Date.now());
  }

  // The IP-check endpoint must be explicitly allowlisted — never a wildcard and never
  // a user-supplied game URL promoted into the allowlist.
  _allowed(url) {
    const h = hostOf(url);
    if (!h) return false;
    return this._allowlist.includes(h);
  }

  /**
   * test(runProxy, opts) -> { state, observedIp, latencyMs, testedAt, error }
   *   runProxy: credential-free { protocol, host, port, requiresAuth } (proxy-config.toRunProxy)
   *   opts.resolveAuth(): optional () -> { username, password } supplied ONLY to the transport
   */
  async test(runProxy, opts = {}) {
    if (!runProxy) return this._result(STATE.NOT_CONFIGURED, { error: { code: 'PROXY_CONFIG_REQUIRED', message: 'No proxy configured for this profile' } });
    const url = opts.ipCheckUrl || this._ipCheckUrl;
    if (!url || !this._allowed(url)) {
      return this._result(STATE.FAILED, { error: { code: 'PROXY_IP_CHECK_NOT_ALLOWLISTED', message: 'IP-check endpoint is not in the allowlist' } });
    }
    if (!this._transport) return this._result(STATE.FAILED, { error: { code: 'PROXY_TRANSPORT_UNAVAILABLE', message: 'No proxy transport configured' } });

    const started = this._now();
    let timer = null;
    const controller = opts.signal ? null : new AbortController();
    const signal = opts.signal || (controller && controller.signal);
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : this._timeoutMs;
    const timeoutP = new Promise((resolve) => { timer = setTimeout(() => { try { controller && controller.abort(); } catch {} resolve({ __timeout: true }); }, timeoutMs); if (timer && timer.unref) timer.unref(); });

    let res;
    try {
      // Auth (if any) is passed ONLY to the transport, never logged or returned.
      const auth = runProxy.requiresAuth && typeof opts.resolveAuth === 'function' ? opts.resolveAuth() : null;
      res = await Promise.race([this._transport({ proxy: runProxy, url, timeoutMs, signal, auth }), timeoutP]);
    } catch (e) {
      res = { ok: false, error: { code: String(e && e.code) === 'ABORT_ERR' ? 'PROXY_OPERATION_CANCELLED' : 'PROXY_CONNECT_FAILED', message: safeMsg(e) } };
    } finally { if (timer) clearTimeout(timer); }

    const latencyMs = this._now() - started;
    if (res && res.__timeout) return this._result(STATE.TIMEOUT, { latencyMs, error: { code: 'PROXY_TEST_TIMEOUT', message: 'Proxy test timed out' } });
    if (!res || !res.ok) {
      const code = (res && res.error && res.error.code) || 'PROXY_CONNECT_FAILED';
      const state = code === 'PROXY_AUTH_FAILED' || code === 'PROXY_AUTH_REQUIRED' ? STATE.AUTH_FAILED
        : code === 'PROXY_OPERATION_CANCELLED' ? STATE.FAILED
          : STATE.FAILED;
      return this._result(state, { latencyMs, error: { code, message: (res && res.error && res.error.message) || 'Proxy connection failed' } });
    }
    return this._result(STATE.PASS, { latencyMs, observedIp: redactIpIfNeeded(res.ip) });
  }

  _result(state, extra = {}) {
    return { state, observedIp: extra.observedIp || null, latencyMs: extra.latencyMs != null ? extra.latencyMs : null, testedAt: new Date(this._now()).toISOString(), error: extra.error || null };
  }
}

// Test-all with a bounded concurrency (§17.E). runner(id) -> Promise<result>.
async function testAll(ids, runner, concurrency = 2) {
  const out = new Map();
  const queue = [...ids];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try { out.set(id, await runner(id)); } catch (e) { out.set(id, { state: STATE.FAILED, error: { code: 'PROXY_CONNECT_FAILED', message: safeMsg(e) } }); }
    }
  });
  await Promise.all(workers);
  return out;
}

function safeMsg(e) { return String((e && e.message) || e || '').slice(0, 200); }
// Observed IP is public-by-nature but we keep only the value, never headers/cookies.
function redactIpIfNeeded(ip) { return ip == null ? null : String(ip).slice(0, 64); }

module.exports = { ProxyTester, testAll, STATE };
