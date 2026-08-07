'use strict';

// Typed failures for the CDP debug loop. Never surface bare "something went wrong".
const CODES = Object.freeze({
  CDP_ENDPOINT_UNAVAILABLE: 'CDP_ENDPOINT_UNAVAILABLE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_DETACHED: 'TARGET_DETACHED',
  TARGET_CONTEXT_UNAVAILABLE: 'TARGET_CONTEXT_UNAVAILABLE',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  RESPONSE_NOT_RECEIVED: 'RESPONSE_NOT_RECEIVED',
  RESPONSE_BODY_NOT_READY: 'RESPONSE_BODY_NOT_READY',
  RESPONSE_BODY_UNAVAILABLE: 'RESPONSE_BODY_UNAVAILABLE',
  CDP_BODY_FETCH_FAILED: 'CDP_BODY_FETCH_FAILED',
  REPLAY_FAILED: 'REPLAY_FAILED',
  REPLAY_BLOCKED_BY_BROWSER: 'REPLAY_BLOCKED_BY_BROWSER',
  INTERCEPT_TIMEOUT: 'INTERCEPT_TIMEOUT',
  INTERCEPT_CONTINUE_FAILED: 'INTERCEPT_CONTINUE_FAILED',
});

class CdpError extends Error {
  constructor(code, message, context) {
    super(message || code);
    this.name = 'CdpError';
    this.code = code;
    this.context = context || undefined;
  }
  toJSON() {
    return { code: this.code, message: this.message, context: this.context };
  }
}

module.exports = { CODES, CdpError };
