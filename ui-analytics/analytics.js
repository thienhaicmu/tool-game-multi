'use strict';

// Aviator Analytics — minimal LIVE renderer (M2). Passive display only.
// No action controls exist here: the only buttons are browser/profile lifecycle.

const api = window.analytics;
const $ = (id) => document.getElementById(id);

let browsers = [];
let selectedId = null;

function fmtTime(ts) { if (!ts) return '—'; try { return new Date(ts).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0'); } catch { return '—'; } }
function fmtOdd(v) { return v == null ? '—' : Number(v).toFixed(2) + 'x'; }
function fmtNum(v) { return v == null ? '—' : String(v); }

function renderBrowsers() {
  const list = $('browser-list');
  list.innerHTML = '';
  if (!browsers.length) { list.innerHTML = '<div class="muted" style="padding:8px">No profiles yet. Add one below.</div>'; return; }
  for (const b of browsers) {
    const el = document.createElement('div');
    el.className = 'browser-item' + (b.browserId === selectedId ? ' selected' : '');
    el.innerHTML =
      `<div class="bi-name"><span class="dot ${b.open ? 'on' : ''}"></span>${escapeHtml(b.displayName)}</div>` +
      `<div class="bi-sub">${escapeHtml(b.browserId)} · ${escapeHtml(b.configuredUrl || '')}</div>` +
      `<div class="bi-actions">` +
      (b.open ? `<button data-act="close">Close</button>` : `<button data-act="open">Open</button>`) +
      `<button data-act="select">Select</button>` +
      `<button data-act="delete" class="danger">Del</button>` +
      `</div>`;
    el.querySelector('[data-act="select"]').onclick = (e) => { e.stopPropagation(); selectBrowser(b.browserId); };
    const openBtn = el.querySelector('[data-act="open"]');
    if (openBtn) openBtn.onclick = async (e) => { e.stopPropagation(); await api.browser.open(b.browserId); selectBrowser(b.browserId); refreshBrowsers(); };
    const closeBtn = el.querySelector('[data-act="close"]');
    if (closeBtn) closeBtn.onclick = async (e) => { e.stopPropagation(); await api.browser.close(b.browserId); refreshBrowsers(); };
    el.querySelector('[data-act="delete"]').onclick = async (e) => { e.stopPropagation(); await api.browser.delete(b.browserId); refreshBrowsers(); };
    el.onclick = () => selectBrowser(b.browserId);
    list.appendChild(el);
  }
}

function renderLive(summary) {
  if (!summary || summary.browserId == null) {
    $('live-name').textContent = 'No profile selected';
    $('live-meta').textContent = '';
    $('chip-capture').textContent = 'Capture: —';
    $('chip-ws').textContent = 'WS: —';
    $('m-sid').textContent = '—'; $('m-odd').textContent = '—'; $('m-jp').textContent = '—'; $('m-count').textContent = '0';
    $('events-body').innerHTML = '';
    return;
  }
  $('live-name').textContent = summary.displayName || summary.browserId;
  $('live-meta').textContent = `${summary.browserId} · ${summary.configuredUrl || ''}`;
  $('chip-capture').textContent = 'Capture: ' + (summary.open ? 'ON' : 'OFF');
  $('chip-ws').textContent = 'WS: ' + (summary.wsStatus || '—');
  $('m-sid').textContent = fmtNum(summary.currentSid);
  $('m-odd').textContent = fmtOdd(summary.currentOdd);
  $('m-jp').textContent = fmtNum(summary.currentJackpot);
  $('m-count').textContent = String(summary.eventCount || 0);
  renderEvents(summary.events || []);
}

function renderEvents(events) {
  const body = $('events-body');
  body.innerHTML = '';
  const rows = events.slice(-200).reverse();
  for (const ev of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${fmtTime(ev.timestamp)}</td>` +
      `<td class="dir-${ev.direction}">${ev.direction}</td>` +
      `<td>${fmtNum(ev.cmd)}</td>` +
      `<td>${escapeHtml(ev.type || 'UNKNOWN')}</td>` +
      `<td>${fmtNum(ev.sid)}</td>` +
      `<td>${ev.odd == null ? '—' : fmtOdd(ev.odd)}</td>` +
      `<td>${fmtNum(ev.jackpot)}</td>`;
    body.appendChild(tr);
  }
}

async function selectBrowser(id) {
  selectedId = id;
  await api.browser.select(id);
  renderBrowsers();
  if (currentTab === 'rounds') { roundsOffset = 0; loadRounds(); }
  else if (currentTab === 'analytics') loadAnalytics();
  else reportViewBounds();
  const summary = await api.live.getSummary(id);
  renderLive(summary);
}

async function refreshBrowsers() {
  browsers = await api.browser.list();
  if (!selectedId && browsers.length) selectedId = browsers[0].browserId;
  renderBrowsers();
}

// Report the on-screen slot rectangle so the native in-app view is positioned over it.
function reportViewBounds() {
  const sel = browsers.find((b) => b.browserId === selectedId);
  if (!sel || !sel.open) return;
  const slot = $('browser-view-slot');
  const r = slot.getBoundingClientRect();
  api.browser.view(selectedId, { x: r.left, y: r.top, width: r.width, height: r.height }, true);
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('create-error').textContent = '';
  const name = $('create-name').value.trim();
  const url = $('create-url').value.trim();
  const res = await api.browser.create({ displayName: name, configuredUrl: url });
  if (res && res.error) { $('create-error').textContent = res.error.message || 'Could not create profile'; return; }
  $('create-name').value = ''; $('create-url').value = '';
  await refreshBrowsers();
});

api.live.onUpdate((summary) => { if (summary && summary.browserId === selectedId) renderLive(summary); refreshDbInfo(); });
api.live.onBrowsersChanged((list) => { browsers = list; renderBrowsers(); });
window.addEventListener('resize', () => { if (currentTab === 'live') reportViewBounds(); });

// ---------------- tabs ----------------
let currentTab = 'live';
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
}
function switchTab(name) {
  currentTab = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('view-live').classList.toggle('hidden', name !== 'live');
  $('view-rounds').classList.toggle('hidden', name !== 'rounds');
  $('view-analytics').classList.toggle('hidden', name !== 'analytics');
  $('view-data').classList.toggle('hidden', name !== 'data');
  // Hide the native in-app view unless on LIVE so it doesn't cover tables.
  if (selectedId) api.browser.view(selectedId, { x: 0, y: 0, width: 0, height: 0 }, name === 'live');
  if (name === 'live') reportViewBounds();
  if (name === 'rounds') loadRounds();
  if (name === 'analytics') loadAnalytics();
  if (name === 'data') loadData();
}

// ---------------- data tab ----------------
let lastOpenedRoundId = null;
async function loadData() {
  const info = await api.db.info();
  const cards = [
    ['Schema version', info.schemaVersion], ['DB size', info.sizeBytes == null ? '—' : (info.sizeBytes / 1e6).toFixed(2) + ' MB'],
    ['Capture sessions', info.sessions], ['Raw events', info.rawEvents], ['Rounds', info.rounds],
    ['ODD samples', info.oddSamples], ['Jackpot samples', info.jackpotSamples],
  ];
  $('data-cards').innerHTML = cards.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div><div class="c-sub">${l === 'Schema version' ? escapeHtml(info.dbPath) : ''}</div></div>`).join('');
}
function dataResult(r, kind) {
  if (!r || r.canceled) { $('data-result').textContent = 'Cancelled.'; return; }
  if (r.error) { $('data-result').textContent = 'Error: ' + (r.error.message || r.error.code); return; }
  if (kind === 'csv') $('data-result').textContent = `Exported ${r.rows} rounds → ${r.path}`;
  else if (kind === 'json') $('data-result').textContent = `Exported round ${r.roundId} → ${r.path}`;
  else if (kind === 'jsonl') $('data-result').textContent = `Exported ${r.lines} raw events → ${r.path}`;
  else if (kind === 'backup') $('data-result').textContent = `Backup written → ${r.path}\nintegrity_check = ${r.integrity}`;
}
$('d-export-rounds').addEventListener('click', async () => dataResult(await api.export.rounds(buildFilter()), 'csv'));
$('d-export-round').addEventListener('click', async () => {
  if (lastOpenedRoundId == null) { $('data-result').textContent = 'Open a round in ROUNDS first.'; return; }
  dataResult(await api.export.roundDetail(lastOpenedRoundId), 'json');
});
$('d-export-raw').addEventListener('click', async () => dataResult(await api.export.rawEvents({ browserId: selectedId || null }), 'jsonl'));
$('d-backup').addEventListener('click', async () => dataResult(await api.backup.database(), 'backup'));

// ---------------- rounds ----------------
const PAGE = 50;
let roundsOffset = 0;
let roundsTotal = 0;

async function loadRounds() {
  const res = await api.rounds.query({ browserId: selectedId || null, limit: PAGE, offset: roundsOffset, sort: 'sequence_number', dir: 'DESC' });
  roundsTotal = res.total || 0;
  renderRounds(res.rounds || []);
  $('rounds-total').textContent = `(${roundsTotal})`;
  const from = roundsTotal === 0 ? 0 : roundsOffset + 1;
  const to = Math.min(roundsOffset + PAGE, roundsTotal);
  $('rounds-page').textContent = `${from}–${to}`;
  $('rounds-prev').disabled = roundsOffset <= 0;
  $('rounds-next').disabled = roundsOffset + PAGE >= roundsTotal;
}
function renderRounds(rows) {
  const body = $('rounds-body');
  body.innerHTML = '';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="muted" style="padding:12px">No rounds captured yet.</td></tr>'; return; }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.sequenceNumber}</td><td>${fmtNum(r.sid)}</td>` +
      `<td>${fmtTime(tsIso(r.openedAtMs))}</td><td>${fmtTime(tsIso(r.endedAtMs))}</td>` +
      `<td>${r.durationMs == null ? '—' : (r.durationMs / 1000).toFixed(2) + 's'}</td>` +
      `<td>${r.maxOdd == null ? '—' : fmtOdd(r.maxOdd)}</td>` +
      `<td>${fmtNum(r.jackpotAtOpen)}</td><td>${fmtNum(r.jackpotAtEnd)}</td>` +
      `<td><span class="cmpl cmpl-${r.completeness}">${r.completeness}</span></td>`;
    tr.onclick = () => openDetail(r.id);
    body.appendChild(tr);
  }
}
$('rounds-prev').onclick = () => { if (roundsOffset > 0) { roundsOffset = Math.max(0, roundsOffset - PAGE); loadRounds(); } };
$('rounds-next').onclick = () => { if (roundsOffset + PAGE < roundsTotal) { roundsOffset += PAGE; loadRounds(); } };

// ---------------- round detail ----------------
async function openDetail(roundId) {
  const d = await api.rounds.detail(roundId);
  if (!d || d.error) return;
  lastOpenedRoundId = roundId;
  const r = d.round;
  $('detail-title').textContent = `Round #${r.sequenceNumber}` + (r.sid != null ? ` · SID ${r.sid}` : '');
  const oddVals = d.oddSamples.map((s) => s.odd);
  const jpVals = d.jackpotSamples.map((s) => s.jackpot);
  $('detail-body').innerHTML =
    section('Identity & Lifecycle', kv([
      ['Round DB id', r.id], ['SID', fmtNum(r.sid)], ['Capture session', r.captureSessionId], ['Completeness', r.completeness],
      ['Opened', fmtTime(tsIso(r.openedAtMs))], ['Locked', fmtTime(tsIso(r.lockedAtMs))],
      ['First odd', fmtTime(tsIso(r.firstOddAtMs))], ['Ended', fmtTime(tsIso(r.endedAtMs))],
      ['Duration', r.durationMs == null ? '—' : (r.durationMs / 1000).toFixed(2) + 's'],
    ])) +
    section('ODD summary', kv([
      ['First', r.firstOdd == null ? '—' : fmtOdd(r.firstOdd)], ['Last', r.lastOdd == null ? '—' : fmtOdd(r.lastOdd)],
      ['Max', r.maxOdd == null ? '—' : fmtOdd(r.maxOdd)], ['Samples', r.oddSampleCount],
    ])) +
    section('ODD timeline (' + oddVals.length + ' samples)', spark(oddVals, false)) +
    section('Jackpot summary', kv([
      ['At open', fmtNum(r.jackpotAtOpen)], ['At lock', fmtNum(r.jackpotAtLock)],
      ['At first odd', fmtNum(r.jackpotAtFirstOdd)], ['At end', fmtNum(r.jackpotAtEnd)],
      ['Min', fmtNum(r.jackpotMin)], ['Max', fmtNum(r.jackpotMax)],
      ['Avg', r.jackpotAvg == null ? '—' : r.jackpotAvg.toFixed(2)], ['Delta', fmtNum(r.jackpotDelta)],
      ['Samples', r.jackpotSampleCount],
    ])) +
    (jpVals.length ? section('Jackpot timeline', spark(jpVals, true)) : '') +
    section('Threshold milestones' + (d.metrics && d.metrics.timingCensored ? ' (timing censored — partial start)' : ''), milestones(d.metrics)) +
    section('Raw events (' + d.relatedRawEvents.length + ')', rawTable(d.relatedRawEvents));
  $('detail-drawer').classList.remove('hidden');
}
$('detail-close').onclick = () => $('detail-drawer').classList.add('hidden');

function section(title, html) { return `<div class="detail-section"><h4>${escapeHtml(title)}</h4>${html}</div>`; }
function kv(pairs) { return '<div class="kv">' + pairs.map(([k, v]) => `<div><span>${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`).join('') + '</div>'; }
function spark(vals, isJp) {
  if (!vals.length) return '<div class="muted">No samples.</div>';
  const max = Math.max(...vals, 0.0001);
  return `<div class="spark${isJp ? ' jp' : ''}">` + vals.map((v) => `<i style="height:${Math.max(2, (v / max) * 100)}%"></i>`).join('') + '</div>';
}
function milestones(metrics) {
  if (!metrics || !metrics.thresholds) return '<div class="muted">No metrics.</div>';
  const rows = Object.keys(metrics.thresholds).map((t) => {
    const m = metrics.thresholds[t];
    const cell = m.reached ? `<span class="ms-yes">reached${m.timeToMs != null ? ' · ' + (m.timeToMs / 1000).toFixed(3) + 's' : ''}</span>` : '<span class="ms-no">not reached</span>';
    return `<tr><td>${Number(t).toFixed(2)}x</td><td>${cell}</td></tr>`;
  });
  return '<table class="milestones">' + rows.join('') + '</table>';
}
function rawTable(events) {
  if (!events.length) return '<div class="muted">No related raw events.</div>';
  const rows = events.map((e) => `<tr><td>${fmtTime(tsIso(e.timestampMs))}</td><td class="dir-${e.direction}">${e.direction}</td><td>${fmtNum(e.cmd)}</td><td>${escapeHtml(e.type || 'UNKNOWN')}</td><td>${fmtNum(e.sid)}</td><td>${e.odd == null ? '—' : fmtOdd(e.odd)}</td><td>${fmtNum(e.jackpot)}</td></tr>`).join('');
  return '<div class="events-table-wrap"><table class="events-table"><thead><tr><th>Time</th><th>Dir</th><th>CMD</th><th>Type</th><th>SID</th><th>ODD</th><th>JP</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

async function refreshDbInfo() {
  try { const info = await api.db.info(); $('db-info').textContent = `DB: ${info.rounds} rounds · ${info.rawEvents} events`; } catch { /* ignore */ }
}

// ---------------- analytics tab ----------------
let currentSub = 'overview';
for (const st of document.querySelectorAll('.subtab')) st.addEventListener('click', () => { currentSub = st.dataset.sub; for (const s of document.querySelectorAll('.subtab')) s.classList.toggle('active', s === st); renderAnalytics(); });
$('f-apply').addEventListener('click', () => loadAnalytics());

function buildFilter() {
  const f = { browserId: selectedId || null };
  const timePreset = $('f-time').value;
  const now = Date.now();
  const presets = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
  if (presets[timePreset]) f.timeFromMs = now - presets[timePreset];
  else if (timePreset === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); f.timeFromMs = d.getTime(); }
  const lastn = $('f-lastn').value; if (lastn) f.lastNRounds = Number(lastn);
  if ($('f-completeness').value === 'ALL') f.completeness = ['COMPLETE', 'PARTIAL_START', 'PARTIAL_END', 'INTERRUPTED', 'UNKNOWN'];
  f.jackpotBasis = $('f-jpbasis').value;
  const jpmin = $('f-jpmin').value, jpmax = $('f-jpmax').value;
  if (jpmin !== '') f.jackpotMin = Number(jpmin);
  if (jpmax !== '') f.jackpotMax = Number(jpmax);
  const hf = $('f-hourfrom').value, ht = $('f-hourto').value;
  if (hf !== '') f.hourFrom = Number(hf);
  if (ht !== '') f.hourTo = Number(ht);
  return f;
}

let lastSummary = null;
async function loadAnalytics() { await renderAnalytics(); }

async function renderAnalytics() {
  const panel = $('analytics-panel');
  const filter = buildFilter();
  const hasBrowser = !!filter.browserId;
  $('m-browserwarn').classList.toggle('hidden', hasBrowser || !['rolling', 'streakgap'].includes(currentSub));
  panel.innerHTML = '<div class="muted" style="padding:12px">Loading…</div>';
  try {
    if (currentSub === 'overview') return renderOverview(await api.stats.overview(filter));
    if (currentSub === 'distribution') return renderDistribution(await api.stats.distribution(filter));
    if (currentSub === 'timing') return renderTiming(await api.stats.timing(filter));
    if (currentSub === 'jackpot') return renderJackpot(await api.stats.jackpotBuckets(filter));
    if (currentSub === 'time') return renderTime(await api.stats.hourly(filter));
    if (currentSub === 'rolling') return renderRolling(await api.stats.rolling(filter, 2, 100));
    if (currentSub === 'streakgap') return renderStreakGap(await api.stats.streaks(filter), await api.stats.gaps(filter));
  } catch (e) { panel.innerHTML = `<div class="disabled-note">Query failed: ${escapeHtml(String(e))}</div>`; }
}

function setMatched(summary) {
  if (!summary) return;
  lastSummary = summary;
  $('m-matched').textContent = `Matched: ${summary.matchedRounds}`;
  $('m-candidate').textContent = `Candidate: ${summary.totalCandidateRounds}`;
  $('m-missing').textContent = `Missing JP basis: ${summary.missingJackpotBasis}`;
}
function pct(v) { return v == null ? '—' : (v * 100).toFixed(2) + '%'; }
function fx(v, d = 2) { return v == null ? '—' : Number(v).toFixed(d); }
function dur(ms) { return ms == null ? '—' : (ms / 1000).toFixed(2) + 's'; }

function renderOverview(r) {
  if (r.error) return bail(r);
  setMatched(r.summary);
  const cards = [
    ['Matched rounds', r.summary.matchedRounds], ['Median maxOdd', fx(r.maxOdd.median)], ['Mean maxOdd', fx(r.maxOdd.mean)],
    ['P90 maxOdd', fx(r.maxOdd.p90)], ['P95 maxOdd', fx(r.maxOdd.p95)], ['Avg duration', dur(r.duration.mean)], ['Median duration', dur(r.duration.median)],
  ];
  let html = '<div class="cards">' + cards.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div></div>`).join('') + '</div>';
  html += '<div class="section-h">Threshold observed rates (historical)</div>';
  html += '<table class="atable"><thead><tr><th>Threshold</th><th>Reached</th><th>n</th><th>Observed Rate</th><th>95% CI</th><th>Sample</th></tr></thead><tbody>';
  for (const t of r.thresholds) html += `<tr><td>≥ ${Number(t.threshold).toFixed(2)}x</td><td>${t.reachedCount}</td><td>${t.sampleCount}</td><td>${pct(t.observedRate)}</td><td class="ci">${t.observedRate == null ? '—' : pct(t.ci95Low) + ' – ' + pct(t.ci95High)}</td><td class="q-${t.sampleQuality}">${t.sampleQuality}</td></tr>`;
  html += '</tbody></table>';
  $('analytics-panel').innerHTML = html;
}

function renderDistribution(r) {
  if (r.error) return bail(r);
  setMatched(r.summary);
  let html = `<div class="section-h">ODD distribution — mutually exclusive buckets (invariant ${r.invariant.ok ? 'OK' : 'FAIL'})</div>`;
  html += '<table class="atable"><thead><tr><th>Bucket</th><th>Count</th><th>Observed Rate</th></tr></thead><tbody>';
  for (const b of r.buckets) html += `<tr><td>${escapeHtml(b.label)}</td><td>${b.count}</td><td>${pct(b.observedRate)}</td></tr>`;
  html += `</tbody></table><div class="muted">Total eligible: ${r.total}</div>`;
  $('analytics-panel').innerHTML = html;
}

function renderTiming(r) {
  if (r.error) return bail(r);
  setMatched(r.summary);
  let html = '<div class="section-h">Timing — censored partial-start rounds excluded</div>';
  html += '<table class="atable"><thead><tr><th>Threshold</th><th>Reached / eligible</th><th>Reach rate</th><th>Timing n</th><th>Median</th><th>P25</th><th>P75</th><th>P90</th><th>P95</th></tr></thead><tbody>';
  for (const t of r.thresholds) html += `<tr><td>≥ ${Number(t.threshold).toFixed(2)}x</td><td>${t.reachedCount} / ${t.eligibleRoundCount}</td><td>${pct(t.reachObservedRate)}</td><td>${t.timingSampleCount}</td><td>${dur(t.timing.median)}</td><td>${dur(t.timing.p25)}</td><td>${dur(t.timing.p75)}</td><td>${dur(t.timing.p90)}</td><td>${dur(t.timing.p95)}</td></tr>`;
  html += '</tbody></table>';
  $('analytics-panel').innerHTML = html;
}

function renderJackpot(r) {
  if (r.error) return bail(r);
  setMatched(r.summary);
  let html = `<div class="section-h">Historical relationship by Jackpot range (basis: ${escapeHtml(r.basis)}) · Missing basis: ${r.missingBasisCount}</div>`;
  html += '<table class="atable"><thead><tr><th>JP bucket</th><th>n</th><th>Median maxOdd</th><th>≥2x</th><th>≥5x</th><th>≥10x</th><th>≥50x</th><th>≥100x</th><th>Median dur</th></tr></thead><tbody>';
  for (const b of r.buckets) html += `<tr><td>${escapeHtml(b.label)}</td><td>${b.samples}</td><td>${fx(b.medianMaxOdd)}</td><td>${pct(b.rates[2])}</td><td>${pct(b.rates[5])}</td><td>${pct(b.rates[10])}</td><td>${pct(b.rates[50])}</td><td>${pct(b.rates[100])}</td><td>${dur(b.medianDuration)}</td></tr>`;
  html += '</tbody></table>';
  $('analytics-panel').innerHTML = html;
}

function renderTime(r) {
  if (r.error) return bail(r);
  setMatched(r.summary);
  let html = '<div class="section-h">Hour of day (local time, 00–23)</div>';
  html += '<table class="atable"><thead><tr><th>Hour</th><th>n</th><th>Median maxOdd</th><th>≥2x</th><th>≥3x</th><th>≥5x</th><th>≥10x</th><th>≥50x</th><th>≥100x</th></tr></thead><tbody>';
  for (const b of r.buckets) html += `<tr><td>${b.label}</td><td>${b.sampleCount}</td><td>${fx(b.medianMaxOdd)}</td><td>${pct(b.rates[2])}</td><td>${pct(b.rates[3])}</td><td>${pct(b.rates[5])}</td><td>${pct(b.rates[10])}</td><td>${pct(b.rates[50])}</td><td>${pct(b.rates[100])}</td></tr>`;
  html += '</tbody></table>';
  $('analytics-panel').innerHTML = html;
}

function renderRolling(r) {
  if (r.disabled) return disabledNote(r);
  if (r.error) return bail(r);
  setMatched(r.summary);
  const rates = r.series.map((p) => p.observedRate);
  let html = `<div class="section-h">Rolling observed rate ≥ ${Number(r.threshold).toFixed(2)}x over previous ${r.window} rounds (${r.series.length} points)</div>`;
  html += '<div class="spark">' + rates.map((v) => `<i style="height:${Math.max(2, v * 100)}%"></i>`).join('') + '</div>';
  if (!r.series.length) html += '<div class="muted" style="padding:8px">Not enough rounds for a full window.</div>';
  $('analytics-panel').innerHTML = html;
}

function renderStreakGap(streaks, gaps) {
  if (streaks.disabled) return disabledNote(streaks);
  if (streaks.error) return bail(streaks);
  setMatched(streaks.summary);
  let left = '<div class="section-h">Streaks (consecutive rounds below threshold)</div><table class="atable"><thead><tr><th>Below</th><th>Current</th><th>Longest</th><th>Completed</th><th>Median</th></tr></thead><tbody>';
  for (const s of streaks.thresholds) left += `<tr><td>&lt; ${Number(s.threshold).toFixed(2)}x</td><td>${s.currentStreak}</td><td>${s.longestStreak}</td><td>${s.completedStreakCount}</td><td>${fx(s.medianCompletedStreak, 1)}</td></tr>`;
  left += '</tbody></table>';
  let right = '<div class="section-h">High-odd gaps (rounds between occurrences)</div><table class="atable"><thead><tr><th>≥</th><th>Occ.</th><th>Current gap</th><th>Median</th><th>P90</th></tr></thead><tbody>';
  for (const g of (gaps.thresholds || [])) right += `<tr><td>≥ ${Number(g.threshold).toFixed(0)}x</td><td>${g.occurrences}</td><td>${g.hasPriorOccurrence ? g.currentGapRounds : g.currentGapRounds + ' (none yet)'}</td><td>${fx(g.medianGapRounds, 0)}</td><td>${fx(g.p90, 0)}</td></tr>`;
  right += '</tbody></table>';
  $('analytics-panel').innerHTML = `<div class="sg-grid"><div>${left}</div><div>${right}</div></div>`;
}

function disabledNote(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml(r.message || 'Unavailable')}</div>`; }
function bail(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml((r.error && r.error.message) || 'Query error')}</div>`; }

function tsIso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

refreshBrowsers();
refreshDbInfo();
