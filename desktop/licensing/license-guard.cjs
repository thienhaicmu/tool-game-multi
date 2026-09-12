'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { getMachineId } = require('./machine-id.cjs');
const { verifyLicense } = require('./license-verifier.cjs');
const { LicenseStore } = require('./license-store.cjs');
const { DEFAULT_TOLERANCE_SECONDS, nextTrustedSeenAt } = require('./clock-guard.cjs');
const { TrustedTimeProvider } = require('./trusted-time.cjs');
const { developmentBypassContext } = require('./dev-bypass.cjs');

function errorResult(code, message, extra = {}) {
  return { active: false, error: { code, message, ...extra } };
}

class LicenseGuard {
  constructor({ userDataPath, safeStorage = null, machineIdProvider = getMachineId, nowMs = null, trustedTimeProvider = null, store = null, publicKeyPem = null, expectedGameProduct = null, devBypass = false } = {}) {
    this._nowMs = nowMs;
    this._trustedTimeProvider = trustedTimeProvider || (nowMs ? null : new TrustedTimeProvider());
    this._machineIdProvider = machineIdProvider;
    this._publicKeyPem = publicKeyPem;
    // Which game this application is (AVIATOR / PHOM). When set, a license that does
    // not grant this game is rejected with a typed mismatch (§3). Aviator apps leave
    // this null or 'AVIATOR' to preserve legacy-key behaviour.
    this._expectedGameProduct = expectedGameProduct;
    // Development-only bypass (§3). NEVER derived here — the caller (phom-main) proves
    // the dev context via resolveDevBypass and passes the boolean in. When true, the
    // guard reports a DEVELOPMENT_BYPASS context WITHOUT verifying any signature.
    this._devBypass = devBypass === true;
    this._machine = null;
    this._status = { active: false, checking: true };
    this._store = store || new LicenseStore({
      licensePath: path.join(userDataPath, 'license.dat'),
      statePath: path.join(userDataPath, 'license-state.dat'),
      safeStorage,
    });
  }

  // A dev bypass short-circuits every entry point to a clearly-marked, non-shippable
  // context. No store read, no signature verification.
  _bypassStatus() {
    return developmentBypassContext(this._expectedGameProduct || 'PHOM', this.machineId());
  }

  initialize() {
    this._machine = this._machineIdProvider();
    if (this._devBypass) { this._status = this._bypassStatus(); return this.status(); }
    if (!this._machine || !this._machine.ok) {
      this._status = errorResult('MACHINE_ID_UNAVAILABLE', 'Machine ID is unavailable');
      return this.status();
    }
    if (this._trustedTimeProvider) {
      this._status = { active: false, checking: true, machineId: this.machineId() };
      return this.status();
    }
    return this.refresh({ consumeLaunch: true });
  }

  async initializeAsync() {
    this._machine = this._machineIdProvider();
    if (this._devBypass) { this._status = this._bypassStatus(); return this.status(); }
    if (!this._machine || !this._machine.ok) {
      this._status = errorResult('MACHINE_ID_UNAVAILABLE', 'Machine ID is unavailable');
      return this.status();
    }
    return this.refreshAsync({ consumeLaunch: true });
  }

  refresh(options = {}) {
    if (this._devBypass) { this._status = this._bypassStatus(); return this.status(); }
    const machineId = this.machineId();
    if (!machineId) return this.status();
    const license = this._store.loadLicense();
    if (!license) {
      this._status = errorResult('LICENSE_MISSING', 'License is missing', { machineId });
      return this.status();
    }
    const nowResult = this._trustedNowSync();
    if (!nowResult.ok) {
      this._status = errorResult(nowResult.error.code, nowResult.error.message, { machineId });
      return this.status();
    }
    this._status = this._verify(license, options, nowResult);
    if (this._status.active) this._store.saveLicense(license);
    return this.status();
  }

  async refreshAsync(options = {}) {
    if (this._devBypass) { this._status = this._bypassStatus(); return this.status(); }
    const machineId = this.machineId();
    if (!machineId) return this.status();
    const license = this._store.loadLicense();
    if (!license) {
      this._status = errorResult('LICENSE_MISSING', 'License is missing', { machineId });
      return this.status();
    }
    const nowResult = await this._trustedNow();
    if (!nowResult.ok) {
      this._status = errorResult(nowResult.error.code, nowResult.error.message, { machineId, attempts: nowResult.error.attempts || [] });
      return this.status();
    }
    this._status = this._verify(license, options, nowResult);
    if (this._status.active) this._store.saveLicense(license);
    return this.status();
  }

  _licenseFingerprint(license) {
    return crypto.createHash('sha256').update(String(license || ''), 'utf8').digest('hex');
  }

  _trustedNowSync() {
    if (this._nowMs) return { ok: true, nowMs: this._nowMs(), source: 'injected' };
    const cachedNowMs = this._trustedTimeProvider && this._trustedTimeProvider.cachedNowMs();
    if (cachedNowMs != null) return { ok: true, nowMs: cachedNowMs, source: 'trusted-cache' };
    return { ok: false, error: { code: 'TRUSTED_TIME_UNAVAILABLE', message: 'Trusted UTC+7 time is not ready' } };
  }

  async _trustedNow() {
    if (this._nowMs) return { ok: true, nowMs: this._nowMs(), source: 'injected' };
    if (!this._trustedTimeProvider) return { ok: false, error: { code: 'TRUSTED_TIME_UNAVAILABLE', message: 'Trusted UTC+7 time provider is unavailable' } };
    return this._trustedTimeProvider.now();
  }

  _verify(license, options = {}, nowResult = null) {
    const machineId = this.machineId();
    const nowMs = nowResult && Number.isFinite(nowResult.nowMs) ? nowResult.nowMs : this._nowMs();
    const nowSeconds = Math.floor(nowMs / 1000);
    const state = this._store.loadState();
    const result = verifyLicense(license, { machineId, nowMs, lastTrustedSeenAt: state.lastTrustedSeenAt || 0, rollbackToleranceSeconds: DEFAULT_TOLERANCE_SECONDS, publicKeyPem: this._publicKeyPem || undefined, expectedGameProduct: this._expectedGameProduct || undefined });
    if (!result.ok) return { ...result, machineId };
    const fingerprint = this._licenseFingerprint(license);
    const launchState = state.launch || {};
    let usedLaunches = launchState.fingerprint === fingerprint ? Number(launchState.used || 0) : 0;
    const maxLaunches = result.payload.maxLaunches || null;
    if (options.consumeLaunch) {
      if (maxLaunches && usedLaunches >= maxLaunches) {
        return { active: false, ok: false, error: { code: 'LICENSE_LAUNCH_LIMIT_REACHED', message: 'License launch limit has been reached', payload: result.payload, usedLaunches, maxLaunches }, machineId };
      }
      usedLaunches += 1;
    }
    const nextSeen = nextTrustedSeenAt(nowSeconds, state.lastTrustedSeenAt);
    this._store.saveState({ ...state, lastTrustedSeenAt: nextSeen, launch: { fingerprint, used: usedLaunches, max: maxLaunches, licenseId: result.payload.licenseId } });
    return { active: true, machineId, payload: result.payload, license, launch: { used: usedLaunches, max: maxLaunches }, nowSeconds, timeSource: nowResult && nowResult.source || 'injected' };
  }

  activate(license) {
    const machineId = this.machineId();
    if (!machineId) return this.status();
    const nowResult = this._trustedNowSync();
    if (!nowResult.ok) {
      this._status = errorResult(nowResult.error.code, nowResult.error.message, { machineId });
      return this.status();
    }
    const result = this._verify(String(license || '').trim(), { consumeLaunch: false }, nowResult);
    if (!result.active) {
      this._status = result;
      return this.status();
    }
    this._store.saveLicense(String(license || '').trim());
    this._status = result;
    return this.status();
  }

  async activateAsync(license) {
    const machineId = this.machineId();
    if (!machineId) return this.status();
    const nowResult = await this._trustedNow();
    if (!nowResult.ok) {
      this._status = errorResult(nowResult.error.code, nowResult.error.message, { machineId, attempts: nowResult.error.attempts || [] });
      return this.status();
    }
    const result = this._verify(String(license || '').trim(), { consumeLaunch: false }, nowResult);
    if (!result.active) {
      this._status = result;
      return this.status();
    }
    this._store.saveLicense(String(license || '').trim());
    this._status = result;
    return this.status();
  }

  machineId() {
    return this._machine && this._machine.ok ? this._machine.machineId : null;
  }

  // Tier 2: the raw stored license string, used to derive the sealed-module key.
  storedLicense() {
    return this._store.loadLicense();
  }

  status() {
    return { ...this._status, checking: Boolean(this._status && this._status.checking), machineId: this.machineId(), hasStoredLicense: Boolean(this._store.loadLicense()) };
  }
}

module.exports = { LicenseGuard };
