'use strict';

// Aviator Analytics renderer — user-facing product (HOME browser-first, jackpot-first
// REPORT, HISTORY, ADVANCED). Passive display only; observe-only, no send/action controls.

const api = window.analytics;
const $ = (id) => document.getElementById(id);

let browsers = [];
let selectedId = null;
let currentTab = 'home';
let currentSub = 'overview';
let currentAdv = 'weblog';
let lastOpenedRoundId = null;

// ---------- formatting ----------
function fmtTime(ts) { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
function fmtOdd(v) { return v == null ? '—' : Number(v).toFixed(2) + 'x'; }
function fmtNum(v) { return v == null ? '—' : String(v); }
function pct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function fx(v, d = 2) { return v == null ? '—' : Number(v).toFixed(d); }
function dur(ms) { return ms == null ? '—' : (ms / 1000).toFixed(2) + 's'; }
function tsIso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }
function shortUrl(u) { if (!u) return '—'; try { const x = new URL(u); return x.pathname + (x.search ? x.search.slice(0, 20) : ''); } catch { return String(u).slice(0, 60); } }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nCls(n) { return n == null ? '' : (n < 30 ? 'q-VERY_LOW' : n < 100 ? 'q-LOW' : ''); }
function section(t, h) { return `<div class="detail-section"><h4>${escapeHtml(t)}</h4>${h}</div>`; }
function kv(p) { return '<div class="kv">' + p.map(([k, v]) => `<div><span>${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`).join('') + '</div>'; }
function spark(vals, jp) { if (!vals.length) return '<div class="muted">Không có mẫu.</div>'; const mx = Math.max(...vals, 0.0001); return `<div class="spark${jp ? ' jp' : ''}">` + vals.map((v) => `<i style="height:${Math.max(2, (v / mx) * 100)}%"></i>`).join('') + '</div>'; }
function preBlock(t) { if (t == null) return '<div class="muted">—</div>'; let s = String(t); try { if (/^\s*[[{]/.test(s)) s = JSON.stringify(JSON.parse(s), null, 2); } catch {} return `<pre class="rawpre">${escapeHtml(s.slice(0, 20000))}</pre>`; }
function jsonBlock(j) { if (!j) return '<div class="muted">—</div>'; try { return preBlock(JSON.stringify(JSON.parse(j), null, 2)); } catch { return preBlock(j); } }

// ---------- browser rail ----------
function renderBrowsers() {
  const list = $('browser-list'); list.innerHTML = '';
  if (!browsers.length) { list.innerHTML = '<div class="muted" style="padding:8px">Chưa có hồ sơ. Thêm bên dưới.</div>'; return; }
  for (const b of browsers) {
    const el = document.createElement('div');
    el.className = 'browser-item' + (b.browserId === selectedId ? ' selected' : '');
    el.innerHTML = `<div class="bi-name"><span class="dot ${b.open ? 'on' : ''}"></span>${escapeHtml(b.displayName)}</div>` +
      `<div class="bi-sub">${escapeHtml(b.browserId)} · ${b.open ? 'Đang mở' : 'Đã đóng'}</div>` +
      `<div class="bi-actions">${b.open ? '<button data-act="close">Đóng</button>' : '<button data-act="open">Mở</button>'}<button data-act="select">Chọn</button><button data-act="delete" class="danger">Xóa</button></div>`;
    el.querySelector('[data-act="select"]').onclick = (e) => { e.stopPropagation(); selectBrowser(b.browserId); };
    const ob = el.querySelector('[data-act="open"]'); if (ob) ob.onclick = async (e) => { e.stopPropagation(); await api.browser.open(b.browserId); selectBrowser(b.browserId); refreshBrowsers(); };
    const cb = el.querySelector('[data-act="close"]'); if (cb) cb.onclick = async (e) => { e.stopPropagation(); await api.browser.close(b.browserId); refreshBrowsers(); };
    el.querySelector('[data-act="delete"]').onclick = async (e) => { e.stopPropagation(); await api.browser.delete(b.browserId); refreshBrowsers(); };
    el.onclick = () => selectBrowser(b.browserId);
    list.appendChild(el);
  }
}
async function refreshBrowsers() { browsers = await api.browser.list(); if (!selectedId && browsers.length) selectedId = browsers[0].browserId; renderBrowsers(); }
async function selectBrowser(id) {
  selectedId = id; await api.browser.select(id); renderBrowsers();
  if (currentTab === 'home') { reportViewBounds(); refreshHome(); }
  else if (currentTab === 'report') loadReport();
  else if (currentTab === 'history') { roundsOffset = 0; loadRounds(); }
  else if (currentTab === 'advanced') loadAdvanced();
}
$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('create-error').textContent = '';
  const res = await api.browser.create({ displayName: $('create-name').value.trim(), configuredUrl: $('create-url').value.trim() });
  if (res && res.error) { $('create-error').textContent = res.error.message || 'Không tạo được hồ sơ'; return; }
  $('create-name').value = ''; $('create-url').value = ''; await refreshBrowsers();
});

// ---------- tabs ----------
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab));
function switchTab(name) {
  currentTab = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('view-home').classList.toggle('hidden', name !== 'home');
  $('view-report').classList.toggle('hidden', name !== 'report');
  $('view-history').classList.toggle('hidden', name !== 'history');
  $('view-advanced').classList.toggle('hidden', name !== 'advanced');
  if (selectedId) api.browser.view(selectedId, { x: 0, y: 0, width: 0, height: 0 }, name === 'home');
  if (name === 'home') { reportViewBounds(); refreshHome(); }
  if (name === 'report') loadReport();
  if (name === 'history') loadRounds();
  if (name === 'advanced') loadAdvanced();
}

// ---------- HOME ----------
$('home-open').addEventListener('click', async () => { if (!selectedId) return; await api.browser.open(selectedId); refreshBrowsers(); reportViewBounds(); });
$('home-report').addEventListener('click', () => switchTab('report'));
function reportViewBounds() {
  const sel = browsers.find((b) => b.browserId === selectedId); if (!sel || !sel.open) return;
  const r = $('browser-view-slot').getBoundingClientRect();
  api.browser.view(selectedId, { x: r.left, y: r.top, width: r.width, height: r.height }, true);
}
window.addEventListener('resize', () => { if (currentTab === 'home') reportViewBounds(); });
async function refreshHome() {
  if (!selectedId) { renderHome(null); return; }
  renderHome(await api.live.getSummary(selectedId));
  loadHomeRecent();
}
function renderHome(s) {
  if (!s || s.browserId == null) { $('home-name').textContent = 'Chưa chọn hồ sơ'; $('home-meta').textContent = ''; $('chip-web').textContent = 'Website: —'; $('chip-capture').textContent = 'Thu thập: —'; $('m-sid').textContent = '—'; $('m-odd').textContent = '—'; $('m-jp').textContent = '—'; $('m-rounds').textContent = '0'; return; }
  $('home-name').textContent = s.displayName || s.browserId;
  $('home-meta').textContent = `${s.browserId} · ${s.configuredUrl || ''}`;
  $('chip-web').textContent = 'Website: ' + (s.open ? 'Đã mở' : 'Đã đóng');
  $('chip-capture').textContent = 'Thu thập: ' + (s.open ? '● ĐANG THU THẬP' : 'Tạm dừng');
  $('chip-capture').classList.toggle('on', !!s.open);
  $('m-sid').textContent = fmtNum(s.currentSid); $('m-odd').textContent = fmtOdd(s.currentOdd); $('m-jp').textContent = fmtNum(s.currentJackpot);
  $('home-open').textContent = s.open ? 'TRÌNH DUYỆT ĐANG MỞ' : 'MỞ TRÌNH DUYỆT';
}
async function loadHomeRecent() {
  const info = await api.db.info().catch(() => null);
  if (info) $('m-rounds').textContent = String(info.rounds || 0);
  if (!selectedId) { $('home-recent').innerHTML = ''; return; }
  const r = await api.report.overview({ browserId: selectedId, lastNRounds: 100 }, jpConfig());
  if (!r || r.error) { $('home-recent').innerHTML = ''; return; }
  const t = (x) => (r.all.thresholds.find((z) => z.threshold === x) || {});
  $('home-recent').innerHTML = `<div class="section-h">Gần đây (100 vòng gần nhất — dữ liệu lịch sử)</div>` +
    `<div class="cards"><div class="card"><div class="c-label">Số vòng</div><div class="c-value">${r.all.n}</div></div>` +
    `<div class="card"><div class="c-label">≥2x</div><div class="c-value">${pct(t(2).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">≥5x</div><div class="c-value">${pct(t(5).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">≥10x</div><div class="c-value">${pct(t(10).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">Trung vị ODD</div><div class="c-value">${fx(r.all.medianMaxOdd)}</div></div></div>`;
}

api.live.onUpdate((s) => { if (s && s.browserId === selectedId && currentTab === 'home') renderHome(s); });
api.live.onBrowsersChanged((list) => { browsers = list; renderBrowsers(); });

// ---------- REPORT (jackpot-first) ----------
for (const st of document.querySelectorAll('#view-report .subtab')) st.addEventListener('click', () => { currentSub = st.dataset.sub; for (const s of document.querySelectorAll('#view-report .subtab')) s.classList.toggle('active', s === st); renderReport(); });
$('f-apply').addEventListener('click', () => loadReport());
function buildFilter() {
  const f = { browserId: selectedId || null };
  const preset = $('f-time').value; const now = Date.now();
  const P = { '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
  if (P[preset]) f.timeFromMs = now - P[preset];
  else if (preset === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); f.timeFromMs = d.getTime(); }
  const ln = $('f-lastn').value; if (ln) f.lastNRounds = Number(ln);
  const hf = $('f-hourfrom').value, ht = $('f-hourto').value;
  if (hf !== '') f.hourFrom = Number(hf); if (ht !== '') f.hourTo = Number(ht);
  return f;
}
function jpConfig() { return { basis: $('f-jpbasis').value }; }
async function loadReport() { await renderReport(); }
function setMatched(summary) {
  if (!summary) return;
  $('m-matched').textContent = `Số vòng: ${summary.matchedRounds != null ? summary.matchedRounds : '—'}`;
  $('m-jpbasis').textContent = 'Jackpot: ' + jpBasisLabel(summary.jackpotBasis);
  $('m-missing').textContent = `Thiếu Jackpot: ${summary.missingJackpotBasis != null ? summary.missingJackpotBasis : '—'}`;
}
function jpBasisLabel(b) { return ({ JACKPOT_AT_OPEN: 'Lúc mở', JACKPOT_AT_LOCK: 'Lúc khóa', JACKPOT_AT_FIRST_ODD: 'ODD đầu', JACKPOT_AT_END: 'Lúc kết thúc', JACKPOT_AVG: 'TB', JACKPOT_MAX: 'Max', JACKPOT_MIN: 'Min', JACKPOT_DELTA: 'Chênh lệch' }[b] || b || ''); }
async function renderReport() {
  const panel = $('analytics-panel'); const f = buildFilter(); const jp = jpConfig();
  const seqTab = ['streakgap'].includes(currentSub);
  $('m-browserwarn').classList.toggle('hidden', !!f.browserId || !seqTab);
  panel.innerHTML = '<div class="muted" style="padding:12px">Đang tải…</div>';
  try {
    if (currentSub === 'overview') return renderOverview(await api.report.overview(f, jp));
    if (currentSub === 'odd') return renderOdd(await api.report.odd(f, jp));
    if (currentSub === 'jackpot') return renderJackpot(await api.report.overview(f, jp), await api.report.delta(f, jp));
    if (currentSub === 'time') return renderTime(await api.report.time(f, jp));
    if (currentSub === 'timing') return renderTiming(await api.report.timing(f, jp, 'median'));
    if (currentSub === 'streakgap') return renderStreakGap(await api.report.streak(f, jp), await api.report.gap(f, jp));
  } catch (e) { panel.innerHTML = `<div class="disabled-note">Lỗi truy vấn: ${escapeHtml(String(e))}</div>`; }
}
function bail(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml((r.error && r.error.message) || 'Lỗi truy vấn')}</div>`; }
function disabledNote(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml(r.message || 'Cần chọn một trình duyệt.')}</div>`; }

function thRow(t) { return `<tr><td>≥ ${Number(t.threshold).toFixed(2)}x</td><td>${t.reachedCount}</td><td class="${nCls(t.sampleCount)}">${t.sampleCount}</td><td>${pct(t.observedRate)}</td><td class="ci">${t.observedRate == null ? '—' : pct(t.ci95Low) + '–' + pct(t.ci95High)}</td></tr>`; }
function jpTheadCols(ranges) { return ranges.map((r) => `<th>${escapeHtml(r.label)}</th>`).join(''); }

function renderOverview(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  const a = r.all;
  let html = `<div class="cards">` +
    `<div class="card"><div class="c-label">Số vòng</div><div class="c-value">${a.n}</div></div>` +
    `<div class="card"><div class="c-label">Trung vị ODD</div><div class="c-value">${fx(a.medianMaxOdd)}</div></div>` +
    `<div class="card"><div class="c-label">P90</div><div class="c-value">${fx(a.p90)}</div></div>` +
    `<div class="card"><div class="c-label">P95</div><div class="c-value">${fx(a.p95)}</div></div>` +
    `<div class="card"><div class="c-label">P99</div><div class="c-value">${fx(a.p99)}</div></div></div>`;
  html += `<div class="section-h">Tỷ lệ quan sát theo ngưỡng (toàn bộ)</div>`;
  html += `<table class="atable"><thead><tr><th>Ngưỡng</th><th>Đạt</th><th>n</th><th>Tỷ lệ quan sát</th><th>95% CI</th></tr></thead><tbody>${a.thresholds.map(thRow).join('')}</tbody></table>`;
  // JACKPOT comparison (primary)
  html += `<div class="section-h">So sánh theo Jackpot (${jpBasisLabel(r.jackpotBasis)}) — phơi nhiễm + tỷ lệ quan sát</div>`;
  html += `<table class="atable"><thead><tr><th>Jackpot</th><th>Số vòng (phơi nhiễm)</th><th>%tập</th><th>Trung vị</th><th>≥2x</th><th>≥5x</th><th>≥10x</th><th>≥100x</th></tr></thead><tbody>`;
  for (const b of r.byRange) { const g = (x) => (b.thresholds.find((z) => z.threshold === x) || {}).observedRate; html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.exposureN)}">${b.exposureN}</td><td>${pct(b.exposureShare)}</td><td>${fx(b.medianMaxOdd)}</td><td>${pct(g(2))}</td><td>${pct(g(5))}</td><td>${pct(g(10))}</td><td>${pct(g(100))}</td></tr>`; }
  html += `</tbody></table><div class="muted">Cột "phơi nhiễm" cho biết mỗi khoảng Jackpot có bao nhiêu vòng, tách bạch với số sự kiện và tỷ lệ.</div>`;
  $('analytics-panel').innerHTML = html;
}

function renderOdd(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  let html = `<div class="section-h">ODD × Jackpot (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>ODD \\ Jackpot</th>${jpTheadCols(r.jackpotRanges)}</tr></thead><tbody>`;
  for (const ob of r.oddBuckets) {
    html += `<tr><td>${escapeHtml(ob.label)}</td>` + ob.cells.map((c) => `<td title="${c.count} vòng">${c.observedRate == null ? '—' : pct(c.observedRate)}<span class="celln"> (${c.count})</span></td>`).join('') + `</tr>`;
  }
  html += `<tr class="exposure-row"><td>Phơi nhiễm (số vòng)</td>` + r.jackpotRanges.map((c) => `<td class="${nCls(c.exposureN)}">${c.exposureN}</td>`).join('') + `</tr>`;
  html += `</tbody></table><div class="muted">Mỗi ô = tỷ lệ vòng trong khoảng Jackpot đó rơi vào khoảng ODD (kèm số vòng). Hàng cuối = phơi nhiễm.</div>`;
  $('analytics-panel').innerHTML = html;
}

function renderJackpot(ov, delta) {
  if (ov.error) return bail(ov); setMatched(ov.summary);
  let html = `<div class="section-h">Khoảng Jackpot × ODD (${jpBasisLabel(ov.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Jackpot</th><th>n</th><th>%tập</th><th>Trung vị</th><th>P90</th><th>≥2x</th><th>≥5x</th><th>≥10x</th><th>≥50x</th><th>≥100x</th><th>TG TB</th></tr></thead><tbody>`;
  for (const b of ov.byRange) { const g = (x) => (b.thresholds.find((z) => z.threshold === x) || {}).observedRate; html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.exposureN)}">${b.exposureN}</td><td>${pct(b.exposureShare)}</td><td>${fx(b.medianMaxOdd)}</td><td>${fx(b.p90)}</td><td>${pct(g(2))}</td><td>${pct(g(5))}</td><td>${pct(g(10))}</td><td>${pct(g(50))}</td><td>${pct(g(100))}</td><td>${dur(b.avgDurationMs)}</td></tr>`; }
  html += `</tbody></table>`;
  if (delta && !delta.error) {
    html += `<div class="section-h">Chênh lệch Jackpot trong vòng × ODD <span class="muted">(nhóm cấu hình được; ${delta.summary.withDelta}/${delta.summary.matchedRounds} có dữ liệu)</span></div>`;
    html += `<table class="atable"><thead><tr><th>Nhóm</th><th>n</th><th>Trung vị ODD</th><th>≥2x</th><th>≥5x</th><th>≥10x</th></tr></thead><tbody>`;
    for (const g of delta.byGroup) html += `<tr><td>${escapeHtml(g.label)}</td><td class="${nCls(g.n)}">${g.n}</td><td>${fx(g.median)}</td><td>${pct(g.rate2)}</td><td>${pct(g.rate5)}</td><td>${pct(g.rate10)}</td></tr>`;
    html += `</tbody></table>`;
  }
  $('analytics-panel').innerHTML = html;
}

function renderTime(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  let html = `<div class="section-h">Giờ trong ngày × Jackpot — tỷ lệ ≥2x (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Giờ</th>${jpTheadCols(r.ranges)}</tr></thead><tbody>`;
  for (const h of r.hours) {
    if (h.byRange.every((b) => b.n === 0)) continue;
    html += `<tr><td>${String(h.hour).padStart(2, '0')}:00</td>` + h.byRange.map((b) => `<td title="${b.n} vòng">${b.n ? pct(b.rate2) : '—'}<span class="celln"> (${b.n})</span></td>`).join('') + `</tr>`;
  }
  html += `</tbody></table><div class="muted">Ô = tỷ lệ ≥2x trong giờ đó cho từng khoảng Jackpot (kèm số vòng). Giờ theo giờ máy.</div>`;
  $('analytics-panel').innerHTML = html;
}

function renderTiming(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  let html = `<div class="section-h">Thời gian đạt ngưỡng × Jackpot — trung vị (loại trừ vòng bị cắt) (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Ngưỡng</th><th>Tất cả (n)</th>${jpTheadCols(r.ranges)}</tr></thead><tbody>`;
  for (const t of r.thresholds) {
    html += `<tr><td>≥ ${Number(t.threshold).toFixed(2)}x</td><td>${t.all.statMs == null ? '—' : dur(t.all.statMs)} <span class="celln">(${t.all.timingN})</span></td>` +
      t.byRange.map((b) => `<td>${b.statMs == null ? '—' : dur(b.statMs)}<span class="celln"> (${b.timingN})</span></td>`).join('') + `</tr>`;
  }
  html += `</tbody></table>`;
  $('analytics-panel').innerHTML = html;
}

function renderStreakGap(streak, gap) {
  if (streak.disabled || gap.disabled) return disabledNote(streak.disabled ? streak : gap);
  if (streak.error) return bail(streak); setMatched(streak.summary);
  let html = `<div class="section-h">Chuỗi (số vòng liên tiếp dưới ngưỡng)</div>`;
  html += `<table class="atable"><thead><tr><th>Dưới</th><th>Hiện tại</th><th>Dài nhất</th><th>Số chuỗi đã kết thúc</th><th>Trung vị</th></tr></thead><tbody>`;
  for (const s of streak.overall) html += `<tr><td>&lt; ${Number(s.threshold).toFixed(2)}x</td><td>${s.currentStreak}</td><td>${s.longestStreak}</td><td>${s.completedStreakCount}</td><td>${fx(s.medianCompletedStreak, 1)}</td></tr>`;
  html += `</tbody></table>`;
  const ctx = streak.context;
  html += `<div class="section-h">Jackpot của các vòng bên trong chuỗi &lt;2x</div>`;
  html += `<table class="atable"><thead><tr><th>Ngữ cảnh</th>${ctx.insideStreaks.map((b) => `<th>${escapeHtml(b.label)}</th>`).join('')}</tr></thead><tbody>`;
  html += `<tr><td>Trong chuỗi</td>${ctx.insideStreaks.map((b) => `<td>${b.n}</td>`).join('')}</tr>`;
  html += `<tr><td>Đầu chuỗi</td>${ctx.atStart.map((b) => `<td>${b.n}</td>`).join('')}</tr>`;
  html += `<tr><td>Cuối chuỗi</td>${ctx.atEnd.map((b) => `<td>${b.n}</td>`).join('')}</tr></tbody></table>`;
  html += `<div class="section-h">Khoảng cách giữa các vòng ODD cao</div>`;
  html += `<table class="atable"><thead><tr><th>≥</th><th>Số lần</th><th>Khoảng hiện tại</th><th>Trung vị</th><th>P90</th></tr></thead><tbody>`;
  for (const g of gap.overall) html += `<tr><td>≥ ${Number(g.threshold).toFixed(0)}x</td><td>${g.occurrences}</td><td>${g.hasPriorOccurrence ? g.currentGapRounds : g.currentGapRounds + ' (chưa có)'}</td><td>${fx(g.medianGapRounds, 0)}</td><td>${fx(g.p90, 0)}</td></tr>`;
  html += `</tbody></table>`;
  const ex10 = gap.exposure.find((e) => e.threshold === 10);
  if (ex10) {
    html += `<div class="section-h">Phơi nhiễm ≥10x theo Jackpot</div>`;
    html += `<table class="atable"><thead><tr><th>Jackpot</th><th>Số vòng đủ điều kiện</th><th>Số lần ≥10x</th><th>Tỷ lệ quan sát</th></tr></thead><tbody>`;
    for (const b of ex10.byRange) html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.eligibleN)}">${b.eligibleN}</td><td>${b.occurrences}</td><td>${pct(b.observedRate)}</td></tr>`;
    html += `</tbody></table>`;
  }
  $('analytics-panel').innerHTML = html;
}

// ---------- HISTORY ----------
const PAGE = 50; let roundsOffset = 0, roundsTotal = 0;
async function loadRounds() {
  const res = await api.rounds.query({ browserId: selectedId || null, limit: PAGE, offset: roundsOffset, sort: 'sequence_number', dir: 'DESC' });
  roundsTotal = res.total || 0; renderRounds(res.rounds || []);
  $('rounds-total').textContent = `(${roundsTotal})`;
  const from = roundsTotal === 0 ? 0 : roundsOffset + 1, to = Math.min(roundsOffset + PAGE, roundsTotal);
  $('rounds-page').textContent = `${from}–${to}`; $('rounds-prev').disabled = roundsOffset <= 0; $('rounds-next').disabled = roundsOffset + PAGE >= roundsTotal;
}
function renderRounds(rows) {
  const body = $('rounds-body'); body.innerHTML = '';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="muted" style="padding:12px">Chưa có vòng nào.</td></tr>'; return; }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.sequenceNumber}</td><td>${fmtTime(tsIso(r.openedAtMs))}</td><td>${fmtNum(r.sid)}</td><td>${r.maxOdd == null ? '—' : fmtOdd(r.maxOdd)}</td><td>${fmtNum(r.jackpotAtOpen)}</td><td>${fmtNum(r.jackpotAtEnd)}</td><td>${r.durationMs == null ? '—' : (r.durationMs / 1000).toFixed(2) + 's'}</td><td><span class="cmpl cmpl-${r.completeness}">${r.completeness}</span></td>`;
    tr.onclick = () => openDetail(r.id); body.appendChild(tr);
  }
}
$('rounds-prev').onclick = () => { if (roundsOffset > 0) { roundsOffset = Math.max(0, roundsOffset - PAGE); loadRounds(); } };
$('rounds-next').onclick = () => { if (roundsOffset + PAGE < roundsTotal) { roundsOffset += PAGE; loadRounds(); } };
$('detail-close').onclick = () => $('detail-drawer').classList.add('hidden');
async function openDetail(id) {
  const d = await api.rounds.detail(id); if (!d || d.error) return; lastOpenedRoundId = id;
  const r = d.round;
  $('detail-title').textContent = `Vòng #${r.sequenceNumber}` + (r.sid != null ? ` · SID ${r.sid}` : '');
  let html = section('Định danh & vòng đời', kv([['SID', fmtNum(r.sid)], ['Trạng thái', r.completeness], ['Mở', fmtTime(tsIso(r.openedAtMs))], ['Kết thúc', fmtTime(tsIso(r.endedAtMs))], ['Thời lượng', r.durationMs == null ? '—' : (r.durationMs / 1000).toFixed(2) + 's']]));
  html += section('ODD', kv([['Đầu', r.firstOdd == null ? '—' : fmtOdd(r.firstOdd)], ['Cuối', r.lastOdd == null ? '—' : fmtOdd(r.lastOdd)], ['Max', r.maxOdd == null ? '—' : fmtOdd(r.maxOdd)], ['Số mẫu', r.oddSampleCount]]));
  html += section('Biểu đồ ODD', spark(d.oddSamples.map((s) => s.odd), false));
  html += section('Jackpot', kv([['Mở', fmtNum(r.jackpotAtOpen)], ['Kết thúc', fmtNum(r.jackpotAtEnd)], ['Min', fmtNum(r.jackpotMin)], ['Max', fmtNum(r.jackpotMax)], ['Số mẫu', r.jackpotSampleCount]]));
  if (d.jackpotSamples.length) html += section('Biểu đồ Jackpot', spark(d.jackpotSamples.map((s) => s.jackpot), true));
  html += section('Mốc ngưỡng' + (d.metrics && d.metrics.timingCensored ? ' (thời gian bị cắt — vòng thu thập dở)' : ''), milestones(d.metrics));
  html += `<details class="tech"><summary>Bằng chứng kỹ thuật (${d.relatedRawEvents.length})</summary>${rawTable(d.relatedRawEvents)}</details>`;
  $('detail-body').innerHTML = html; $('detail-drawer').classList.remove('hidden');
}
function milestones(m) { if (!m || !m.thresholds) return '<div class="muted">—</div>'; return '<table class="milestones">' + Object.keys(m.thresholds).map((t) => { const x = m.thresholds[t]; return `<tr><td>${Number(t).toFixed(2)}x</td><td>${x.reached ? '<span class="ms-yes">đạt' + (x.timeToMs != null ? ' · ' + (x.timeToMs / 1000).toFixed(3) + 's' : '') + '</span>' : '<span class="ms-no">không đạt</span>'}</td></tr>`; }).join('') + '</table>'; }
function rawTable(events) { if (!events.length) return '<div class="muted">Không có.</div>'; return '<div class="events-table-wrap"><table class="events-table"><thead><tr><th>Thời gian</th><th>Hướng</th><th>CMD</th><th>Type</th><th>SID</th><th>ODD</th><th>JP</th></tr></thead><tbody>' + events.map((e) => `<tr><td>${fmtTime(tsIso(e.timestampMs))}</td><td class="dir-${e.direction}">${e.direction}</td><td>${fmtNum(e.cmd)}</td><td>${escapeHtml(e.type || '')}</td><td>${fmtNum(e.sid)}</td><td>${e.odd == null ? '—' : fmtOdd(e.odd)}</td><td>${fmtNum(e.jackpot)}</td></tr>`).join('') + '</tbody></table></div>'; }

// ---------- ADVANCED ----------
for (const st of document.querySelectorAll('#view-advanced .subtab')) st.addEventListener('click', () => { currentAdv = st.dataset.adv; for (const s of document.querySelectorAll('#view-advanced .subtab')) s.classList.toggle('active', s === st); loadAdvanced(); });
function loadAdvanced() {
  $('adv-weblog').classList.toggle('hidden', currentAdv !== 'weblog');
  $('adv-network').classList.toggle('hidden', currentAdv !== 'network');
  $('adv-data').classList.toggle('hidden', currentAdv !== 'data');
  if (currentAdv === 'weblog') loadWebLog();
  if (currentAdv === 'network') loadNetwork();
  if (currentAdv === 'data') loadData();
}

// Web Log
const WL_PAGE = 100; let wlOffset = 0, wlTotal = 0;
function wlFilter() {
  const f = { browserId: selectedId || null };
  if ($('wl-type').value) f.resourceType = $('wl-type').value;
  const m = $('wl-method').value.trim(); if (m) f.method = m;
  if ($('wl-status').value) f.statusFamily = $('wl-status').value;
  const host = $('wl-host').value.trim(); if (host) f.host = host;
  const url = $('wl-url').value.trim(); if (url) f.urlContains = url;
  if ($('wl-wsdir').value) f.wsDirection = $('wl-wsdir').value;
  const cmd = $('wl-cmd').value.trim(); if (cmd) f.cmd = Number(cmd);
  if ($('wl-hasodd').checked) f.hasOdd = true; if ($('wl-hasjp').checked) f.hasJackpot = true;
  return f;
}
async function loadWebLog() {
  const res = await api.webLog.query(wlFilter(), { limit: WL_PAGE, offset: wlOffset }); wlTotal = res.total || 0; renderWebLog(res.rows || []);
  $('wl-total').textContent = `(${wlTotal})`; const from = wlTotal === 0 ? 0 : wlOffset + 1, to = Math.min(wlOffset + WL_PAGE, wlTotal);
  $('wl-page').textContent = `${from}–${to}`; $('wl-prev').disabled = wlOffset <= 0; $('wl-next').disabled = wlOffset + WL_PAGE >= wlTotal;
}
function renderWebLog(rows) {
  const body = $('wl-body'); body.innerHTML = '';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="10" class="muted" style="padding:12px">Không có dữ liệu.</td></tr>'; return; }
  for (const r of rows) {
    const tr = document.createElement('tr'); const cls = r.kind === 'WS' ? 'dir-' + (r.direction || 'RECV') : '';
    tr.innerHTML = `<td>${fmtTime(tsIso(r.ts))}</td><td class="${cls}">${escapeHtml(r.type)}${r.kind === 'WS' && r.direction === 'SEND' ? ' <span class="wsend">website</span>' : ''}</td><td>${escapeHtml(r.method || '')}</td><td>${r.status == null ? '' : r.status}</td><td>${escapeHtml(r.host ? hostOf(r.host) : '')}</td><td class="mono">${escapeHtml(shortUrl(r.url))}</td><td>${r.duration == null ? '—' : Math.round(r.duration) + 'ms'}</td><td>${r.size == null ? '—' : r.size}</td><td>${fmtNum(r.cmd)}</td><td>${fmtNum(r.sid)}</td>`;
    tr.onclick = () => openWebLogDetail(r.kind, r.id); body.appendChild(tr);
  }
}
$('wl-apply').onclick = () => { wlOffset = 0; loadWebLog(); };
$('wl-prev').onclick = () => { if (wlOffset > 0) { wlOffset = Math.max(0, wlOffset - WL_PAGE); loadWebLog(); } };
$('wl-next').onclick = () => { if (wlOffset + WL_PAGE < wlTotal) { wlOffset += WL_PAGE; loadWebLog(); } };
$('wl-detail-close').onclick = () => $('weblog-drawer').classList.add('hidden');
async function openWebLogDetail(kind, id) {
  const d = await api.webLog.detail(kind, id); if (!d || d.error) return;
  if (d.kind === 'WS') { const ev = d.event, conn = d.connection; $('wl-detail-title').textContent = `WS ${ev.direction}${ev.direction === 'SEND' ? ' (website)' : ''}`;
    let h = section('Khung WebSocket', kv([['Hướng', ev.direction === 'SEND' ? 'WEBSITE SEND' : 'RECV (server)'], ['Thời gian', fmtTime(tsIso(ev.timestamp_ms))], ['CMD', fmtNum(ev.cmd)], ['Type', ev.event_type], ['SID', fmtNum(ev.sid)], ['ODD', ev.odd == null ? '—' : fmtOdd(ev.odd)], ['Jackpot', fmtNum(ev.jackpot)]]));
    if (conn) h += section('Kết nối', kv([['URL', conn.url], ['SEND', conn.send_count], ['RECV', conn.recv_count]]));
    h += section('Payload thô', preBlock(ev.payload)); $('wl-detail-body').innerHTML = h; $('weblog-drawer').classList.remove('hidden'); return; }
  const req = d.request, resp = d.response, b = d.body;
  $('wl-detail-title').textContent = `${req.method || ''} ${hostOf(req.url)}`;
  let h = section('Tổng quan', kv([['URL', req.url], ['Method', req.method], ['Status', resp ? (resp.status + ' ' + (resp.status_text || '')) : '—'], ['Loại', req.resource_type], ['Host', req.host], ['Thời lượng', resp && resp.duration_ms != null ? resp.duration_ms + 'ms' : '—']]));
  h += section('Request headers', jsonBlock(req.request_headers));
  if (req.request_body) h += section('Request payload', preBlock(req.request_body));
  h += section('Response headers', jsonBlock(resp ? resp.response_headers : null));
  h += section('Response body', b ? (b.capture_status === 'CAPTURED' ? preBlock(b.body) : `<div class="muted">${escapeHtml(b.capture_status)}${b.body_size != null ? ' (' + b.body_size + ' bytes)' : ''}</div>`) : '<div class="muted">—</div>');
  h += `<div class="muted" style="margin-top:8px">Chỉ là bằng chứng quan sát — không phát lại / gửi lại.</div>`;
  $('wl-detail-body').innerHTML = h; $('weblog-drawer').classList.remove('hidden');
}

// Network report (Advanced)
async function loadNetwork() {
  const f = { browserId: selectedId || null };
  const ov = await api.network.overview(f), eps = await api.network.endpoints(f), hosts = await api.network.hosts(f);
  if (ov.error) { $('network-panel').innerHTML = bailText(ov); return; }
  const cards = [['Tổng request', ov.totalRequests], ['Req/phút', ov.requestsPerMinute == null ? '—' : ov.requestsPerMinute.toFixed(1)], ['XHR', ov.xhrCount], ['Fetch', ov.fetchCount], ['WS SEND (website)', ov.wsSendCount], ['WS RECV', ov.wsRecvCount], ['2xx', ov.status['2xx']], ['4xx', ov.status['4xx']], ['5xx', ov.status['5xx']], ['Lỗi', ov.status.failed], ['Trung vị dur', ov.durationMedianMs == null ? '—' : Math.round(ov.durationMedianMs) + 'ms'], ['P95 dur', ov.durationP95Ms == null ? '—' : Math.round(ov.durationP95Ms) + 'ms']];
  let html = `<div class="section-h">Hoạt động mạng quan sát</div><div class="cards">` + cards.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div></div>`).join('') + '</div>';
  html += `<div class="section-h">Endpoint hàng đầu</div><table class="atable"><thead><tr><th>Endpoint</th><th>Số</th><th>2xx-3xx</th><th>4xx</th><th>5xx</th><th>Lỗi</th><th>Trung vị</th><th>P95</th></tr></thead><tbody>` + (eps.endpoints || []).map((e) => `<tr><td>${escapeHtml(e.key)}</td><td>${e.count}</td><td>${e.success}</td><td>${e.c4xx}</td><td>${e.c5xx}</td><td>${e.failures}</td><td>${e.medianDurationMs == null ? '—' : Math.round(e.medianDurationMs) + 'ms'}</td><td>${e.p95DurationMs == null ? '—' : Math.round(e.p95DurationMs) + 'ms'}</td></tr>`).join('') + '</tbody></table>';
  html += `<div class="section-h">Host hàng đầu</div><table class="atable"><thead><tr><th>Host</th><th>Request</th><th>XHR/Fetch</th><th>Lỗi</th></tr></thead><tbody>` + (hosts.hosts || []).map((h) => `<tr><td>${escapeHtml(h.host)}</td><td>${h.requestCount}</td><td>${h.xhrFetchCount}</td><td>${h.errorCount}</td></tr>`).join('') + '</tbody></table>';
  $('network-panel').innerHTML = html;
}
function bailText(r) { return `<div class="disabled-note">${escapeHtml((r.error && r.error.message) || 'Lỗi')}</div>`; }

// Data
async function loadData() {
  const info = await api.db.info();
  const cards = [['Phiên bản schema', info.schemaVersion], ['Kích thước', info.sizeBytes == null ? '—' : (info.sizeBytes / 1e6).toFixed(2) + ' MB'], ['Phiên thu thập', info.sessions], ['Request mạng', info.networkRequests], ['Response', info.networkResponses], ['Body', info.networkBodies], ['WS kết nối', info.wsConnections], ['WS sự kiện', info.wsEvents], ['Sự kiện giao thức', info.rawEvents], ['Vòng', info.rounds], ['Mẫu ODD', info.oddSamples], ['Mẫu Jackpot', info.jackpotSamples]];
  $('data-cards').innerHTML = cards.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div></div>`).join('');
}
function dataResult(r, kind) {
  if (!r || r.canceled) { $('data-result').textContent = 'Đã hủy.'; return; }
  if (r.error) { $('data-result').textContent = 'Lỗi: ' + (r.error.message || r.error.code); return; }
  if (kind === 'csv') $('data-result').textContent = `Đã xuất ${r.rows} vòng → ${r.path}`;
  else if (kind === 'json') $('data-result').textContent = `Đã xuất vòng ${r.roundId} → ${r.path}`;
  else if (kind === 'jsonl') $('data-result').textContent = `Đã xuất ${r.lines} sự kiện → ${r.path}`;
  else if (kind === 'weblog') $('data-result').textContent = `Đã xuất ${r.rows} dòng nhật ký → ${r.path}`;
  else if (kind === 'backup') $('data-result').textContent = `Sao lưu → ${r.path}\nintegrity_check = ${r.integrity}`;
}
$('d-export-rounds').onclick = async () => dataResult(await api.export.rounds(buildFilter()), 'csv');
$('d-export-round').onclick = async () => { if (lastOpenedRoundId == null) { $('data-result').textContent = 'Mở một vòng trong LỊCH SỬ trước.'; return; } dataResult(await api.export.roundDetail(lastOpenedRoundId), 'json'); };
$('d-export-raw').onclick = async () => dataResult(await api.export.rawEvents({ browserId: selectedId || null }), 'jsonl');
$('d-export-weblog').onclick = async () => dataResult(await api.export.webLog({ browserId: selectedId || null }), 'weblog');
$('d-backup').onclick = async () => dataResult(await api.backup.database(), 'backup');

// ---------- boot ----------
refreshBrowsers().then(() => refreshHome());
