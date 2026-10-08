'use strict';

// ---------------------------------------------------------------------------
// FEATURE header — the tool-owned control bar inside each browser (protocol/phom/game-header.cjs is the page side).
//  attach: boot the bar (a fresh N3 key per attach) through the binding bridge; every key a run was given stays valid
//          (a page booted by an earlier attach keeps working), any other caller is refused.
//  action: one click from the bar → N3 key check → __HEADER_STATUS (the page reports its bar is in the DOM) → identity +
//          single-flight guard → TỰ ĐỘNG lock for table buttons → live-client check → the route for that action. A
//          busy-exempt action (HỦY / ⟳ …) runs ALONGSIDE the long operation it escapes and never takes the flag.
//  push:   a stale error goes once the browser's state moved on; the derived bar state is pushed only when it changed
//          (a CDP evaluate per frame per browser was the storm the clicks rode on).
//
// state: session.header = { ready, domPresent, lastPushed, error, errorState, keys, busy, lastActionId, findConfirmUntil }
// deps:  { sessions, bootScript(opts), installHeader(client, opts), clientFor(rid), runOf(rid), evaluateHeaderAction,
//          isBusyExempt(action), tableActions:Set, autoActive(), routes:{ ACTION: (rid, payload, ctx) => Promise<res> },
//          deriveHeaderState(view), stateCode(view), log, refresh(), now, newKey() }
// ---------------------------------------------------------------------------

const FIND_CONFIRM_MS = 5000; // rule D2 — a second Dò Key within 5 s confirms replacing the group

function createHeaderFeature(deps) {
  const { sessions, log = () => {}, refresh = () => {}, now = () => Date.now() } = deps;

  async function action(runId, payload) {
    const rid = String(runId == null ? '' : runId);
    const s = sessions.get(rid);
    const act = payload && payload.action;
    const actionId = (payload && payload.actionId) || null;
    // N3 — only our own bar may act: the message must carry a key this run was given (a page script cannot know it)
    if (!payload || typeof payload.key !== 'string' || !s.header.keys.has(payload.key)) {
      log('action-rejected', { runId: rid, action: act, reason: 'BAD_KEY' });
      return { ok: false, error: { code: 'PHOM_HEADER_FORGED', message: 'Lệnh không đến từ thanh của tool — bỏ qua.' } };
    }
    // the page reports its bar's DOM presence (mount / remount — never per frame) → force a re-push to fill it
    if (act === '__HEADER_STATUS') {
      s.header.domPresent = !!payload.present;
      log('HEADER_DOM_PRESENT', { runId: rid, slotId: payload.slotId, present: s.header.domPresent });
      s.header.lastPushed = null;
      refresh();
      return { ok: true, internal: true };
    }
    log('action-route', { runId: rid, slotId: payload.slotId, action: act, actionId });
    const run = deps.runOf(rid);
    const guard = deps.evaluateHeaderAction({ payload, boundRunId: rid, runProfileId: run && run.profileId, busy: !!s.header.busy, lastActionId: s.header.lastActionId || null });
    if (!guard.ok) { log('action-rejected', { runId: rid, action: act, actionId, reason: guard.reason }); return { ok: false, busy: guard.reason === 'DUPLICATE_ACTION', error: { code: guard.code, message: guard.message } }; }
    // rule D1 — TỰ ĐỘNG drives the table: a table click that still arrives (an old bar not repainted yet) is refused
    if (deps.tableActions.has(act) && deps.autoActive()) {
      log('action-rejected', { runId: rid, action: act, actionId, reason: 'AUTO_ACTIVE' });
      return { ok: false, error: { code: 'PHOM_AUTO_ACTIVE', message: 'Đang TỰ ĐỘNG — bỏ tích ô Tự động ở tool Phỏm để bấm tay.' } };
    }
    // §12 — never route into a dead CDP session
    if (!deps.clientFor(rid)) {
      log('action-no-client', { runId: rid, action: act, actionId });
      s.header.error = 'Chromium mất kết nối — MỞ lại trình duyệt.'; refresh();
      return { ok: false, error: { code: 'PHOM_HEADER_NO_CLIENT', message: 'no live CDP client' } };
    }
    const exempt = deps.isBusyExempt(act);
    if (!exempt) s.header.busy = true;
    if (actionId != null) s.header.lastActionId = actionId;
    s.header.error = null;
    const t0 = now();
    let res;
    try {
      const route = deps.routes[act];
      if (!route) res = { ok: false, error: { code: 'PHOM_HEADER_UNKNOWN_ACTION', message: `unknown action ${act}` } };
      else if (act === 'FIND_TABLE') {
        const force = !!(s.header.findConfirmUntil && now() <= s.header.findConfirmUntil);
        s.header.findConfirmUntil = 0;
        res = await route(rid, payload, { force, actionId });
        if (res && res.needsConfirm) s.header.findConfirmUntil = now() + FIND_CONFIRM_MS;
      } else res = await route(rid, payload, { actionId });
    } catch (e) { res = { ok: false, error: { code: 'PHOM_HEADER_ACTION_FAILED', message: String((e && e.message) || e).slice(0, 200) } }; }
    finally { if (!exempt) s.header.busy = false; }
    if (res && res.ok === false) s.header.error = (res.error && (res.error.message || res.error.code)) || 'LỖI';
    log('action-done', { runId: rid, action: act, actionId, ok: !!(res && res.ok), error: res && res.error && res.error.code, elapsedMs: Math.round(now() - t0) });
    refresh();
    return res || { ok: true };
  }

  function attach({ run, client }) {
    const s = sessions.get(run.id);
    const key = deps.newKey();
    s.header.keys.add(key);
    const boot = deps.bootScript({ nonce: key, slotId: run.slot || null, profileId: run.profileId || null, runId: run.id });
    return deps.installHeader(client, { runId: run.id, slotId: run.slot || null, boot, onAction: (rid, payload) => action(rid, payload), log })
      .then((r) => { s.header.ready = !!(r && r.ok); refresh(); });
  }

  // a stale error belongs to the state it happened in: once that browser's state changed, it is cleared
  function settleError(s, code) {
    if (s.header.error == null) { s.header.errorState = null; return; }
    if (s.header.errorState == null) { s.header.errorState = code; return; }
    if (s.header.errorState !== code) { s.header.error = null; s.header.errorState = null; }
  }

  function push({ run, session, view }) {
    const client = deps.clientFor(run.id);
    if (!client || !view) return;
    settleError(session, deps.stateCode(view));
    view.error = session.header.error || null;
    const json = JSON.stringify(deps.deriveHeaderState(view));
    if (session.header.lastPushed === json) return;           // unchanged → no CDP round-trip
    session.header.lastPushed = json;
    client.Runtime.evaluate({ expression: `window.__phomHeaderRender && window.__phomHeaderRender(${json})` }).catch((e) => log('push-error', { runId: String(run.id), error: String((e && e.message) || e) }));
  }

  // the page is gone / replaced: the bar has to be confirmed and filled again
  function forget(s, { clearError = true } = {}) { s.header.domPresent = false; s.header.lastPushed = null; if (clearError) s.header.error = null; }

  return {
    id: 'header',
    attach,
    action,
    push,
    documentReplaced({ session }) { forget(session); },
    reset(rid) { const s = sessions.peek(rid); if (s) forget(s); },                                   // the tool's own ⟳
    detached(rid) { const s = sessions.peek(rid); if (s) { forget(s, { clearError: false }); s.header.ready = false; } },
    // the bar's honest status for the tool window: binding installed + DOM confirmed by the page
    status(rid) { const s = sessions.peek(rid); return { ready: !!(s && s.header.ready), domPresent: !!(s && s.header.domPresent) }; },
    errorOf(rid) { const s = sessions.peek(rid); return (s && s.header.error) || null; },
    setError(rid, msg) { sessions.get(rid).header.error = msg; },
  };
}

module.exports = { createHeaderFeature, FIND_CONFIRM_MS };
