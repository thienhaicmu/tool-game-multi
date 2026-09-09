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
let timeMetric = 'hour';   // 'hour' | 'timing' — the metric shown inside the merged "Thời gian" section
let lastOpenedRoundId = null;

// ---------- formatting (centralized in format.js / window.AFmt; display only) ----------
const F = window.AFmt;
function fmtTime(ts) { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
const fmtOdd = (v) => F.odd(v);        // ODD → "2.00×"
const fmtNum = (v) => F.id(v);         // identifiers (SID / CMD) — never grouped
const fmtJp = (v) => F.jackpot(v);     // jackpot values — grouped thousands
const pct = (v) => F.percent(v);       // fraction → "12.35%"
const ciBand = (lo, hi) => F.ci(lo, hi);
const cnt = (v) => F.count(v);         // sample sizes — grouped
const fx = (v, d = 2) => F.fixed(v, d);
const dur = (ms) => F.duration(ms);
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
  $('view-research').classList.toggle('hidden', name !== 'research');
  $('view-advanced').classList.toggle('hidden', name !== 'advanced');
  if (selectedId) api.browser.view(selectedId, { x: 0, y: 0, width: 0, height: 0 }, name === 'home');
  if (name === 'home') { reportViewBounds(); refreshHome(); }
  if (name === 'report') loadReport();
  if (name === 'history') loadRounds();
  if (name === 'research') loadResearch();
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
  // Collection status reflects the ACTUAL Aviator context, not merely whether the browser is
  // open (WU-CONTEXT §9). "ĐANG THU THẬP" only when authoritative Aviator evidence is flowing;
  // otherwise the user is told to (re)enter the game while the passive collector stays attached.
  const ctx = s.aviatorContext;
  let captureText = 'Tạm dừng';
  let capturing = false;
  if (s.open) {
    // Entry-only auto-reentry adds REENTERING / LOGIN_REQUIRED / RECOVERY_FAILED runtime states.
    if (ctx === 'AVIATOR_ACTIVE') { captureText = '● ĐANG THU THẬP'; capturing = true; }
    else if (ctx === 'AVIATOR_VERIFYING') { captureText = 'ĐANG KIỂM TRA GAME'; }
    else if (ctx === 'AVIATOR_REENTERING') { captureText = 'ĐANG VÀO LẠI GAME'; }
    else if (ctx === 'AVIATOR_LOGIN_REQUIRED') { captureText = 'CẦN ĐĂNG NHẬP'; }
    else if (ctx === 'AVIATOR_RECOVERY_FAILED') { captureText = 'KHÔNG THỂ VÀO LẠI GAME'; }
    else if (ctx === 'AVIATOR_CONTEXT_LOST') { captureText = 'MẤT KẾT NỐI GAME'; }
    else { captureText = 'CẦN VÀO LẠI GAME'; } // AVIATOR_UNKNOWN (not in game yet)
  }
  $('chip-capture').textContent = 'Thu thập: ' + captureText;
  $('chip-capture').classList.toggle('on', capturing);
  $('m-sid').textContent = fmtNum(s.currentSid); $('m-odd').textContent = fmtOdd(s.currentOdd); $('m-jp').textContent = fmtJp(s.currentJackpot);
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
    `<div class="cards"><div class="card"><div class="c-label">Số vòng</div><div class="c-value">${cnt(r.all.n)}</div></div>` +
    `<div class="card"><div class="c-label">≥2×</div><div class="c-value">${pct(t(2).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">≥5×</div><div class="c-value">${pct(t(5).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">≥10×</div><div class="c-value">${pct(t(10).observedRate)}</div></div>` +
    `<div class="card"><div class="c-label">Trung vị ODD</div><div class="c-value">${fmtOdd(r.all.medianMaxOdd)}</div></div></div>`;
}

api.live.onUpdate((s) => { if (s && s.browserId === selectedId && currentTab === 'home') renderHome(s); });
api.live.onBrowsersChanged((list) => { browsers = list; renderBrowsers(); });

// ---------- REPORT (jackpot-first) ----------
// Authoritative Jackpot ranges — HALF-OPEN [min, max); final bucket open-ended (max=null).
// Mirrors the backend DEFAULT_JP_RANGES (a drift guard test asserts they stay identical), so the
// UI range selection filters on exactly the same boundaries the report buckets by.
const JP_RANGES = [
  { label: '0–100', min: 0, max: 100 }, { label: '100–200', min: 100, max: 200 }, { label: '200–300', min: 200, max: 300 },
  { label: '300–500', min: 300, max: 500 }, { label: '500–750', min: 500, max: 750 }, { label: '750–1,000', min: 750, max: 1000 },
  { label: '1,000–2,000', min: 1000, max: 2000 }, { label: '≥2,000', min: 2000, max: null },
];
function populateJpRanges() {
  const sel = $('f-jprange'); if (!sel || sel.options.length > 1) return;
  for (let i = 0; i < JP_RANGES.length; i++) { const r = JP_RANGES[i]; const o = document.createElement('option'); o.value = String(i); o.textContent = r.label; sel.appendChild(o); }
}
for (const st of document.querySelectorAll('#view-report .subtab')) st.addEventListener('click', () => { currentSub = st.dataset.sub; for (const s of document.querySelectorAll('#view-report .subtab')) s.classList.toggle('active', s === st); renderReport(); });
$('f-apply').addEventListener('click', () => loadReport());
function selectedRange() { const v = $('f-jprange').value; if (v === '') return null; const r = JP_RANGES[Number(v)]; return r || null; }
function buildFilter() {
  const f = { browserId: selectedId || null };
  const preset = $('f-time').value; const now = Date.now();
  const P = { '1h': 36e5, '3h': 108e5, '6h': 216e5, '12h': 432e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
  if (P[preset]) f.timeFromMs = now - P[preset];
  else if (preset === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); f.timeFromMs = d.getTime(); }
  const ln = $('f-lastn').value; if (ln) f.lastNRounds = Number(ln);
  const hf = $('f-hourfrom').value, ht = $('f-hourto').value;
  if (hf !== '') f.hourFrom = Number(hf); if (ht !== '') f.hourTo = Number(ht);
  // The range predicate filters on the SELECTED basis column, so the filter's basis MUST equal the
  // report's basis (jpConfig). Otherwise the range would filter one column while bucketing another.
  f.jackpotBasis = $('f-jpbasis').value;
  const rng = selectedRange();
  if (rng) { f.jackpotRangeMin = rng.min; if (rng.max != null) f.jackpotRangeMax = rng.max; }  // half-open; open-ended omits max
  return f;
}
function jpConfig() { return { basis: $('f-jpbasis').value }; }
async function loadReport() { await renderReport(); }
function setMatched(summary) {
  if (!summary) return;
  $('m-matched').textContent = `Số vòng: ${summary.matchedRounds != null ? cnt(summary.matchedRounds) : '—'}`;
  const rng = selectedRange();
  $('m-jpbasis').textContent = 'Jackpot: ' + jpBasisLabel(summary.jackpotBasis) + (rng ? ' · ' + rng.label : '');
  $('m-missing').textContent = `Thiếu Jackpot: ${summary.missingJackpotBasis != null ? cnt(summary.missingJackpotBasis) : '—'}`;
}
function jpBasisLabel(b) { return ({ JACKPOT_AT_OPEN: 'Lúc mở', JACKPOT_AT_LOCK: 'Lúc khóa', JACKPOT_AT_FIRST_ODD: 'ODD đầu', JACKPOT_AT_END: 'Lúc kết thúc', JACKPOT_AVG: 'TB', JACKPOT_MAX: 'Max', JACKPOT_MIN: 'Min', JACKPOT_DELTA: 'Chênh lệch' }[b] || b || ''); }
async function renderReport() {
  const panel = $('analytics-panel'); const f = buildFilter(); const jp = jpConfig();
  const seqTab = ['streakgap'].includes(currentSub);
  $('m-browserwarn').classList.toggle('hidden', !!f.browserId || !seqTab);
  panel.innerHTML = '<div class="muted" style="padding:12px">Đang tải…</div>';
  try {
    if (currentSub === 'overview') return renderOverview(await api.report.overview(f, jp));
    if (currentSub === 'jackpot') return renderJackpot(await api.report.overview(f, jp), await api.report.delta(f, jp), await api.report.stats(f, jp));
    if (currentSub === 'odd') return renderOdd(await api.report.odd(f, jp));
    if (currentSub === 'time') return renderTimeTab(f, jp);
    if (currentSub === 'streakgap') return renderStreakGap(await api.report.streak(f, jp), await api.report.gap(f, jp));
  } catch (e) { panel.innerHTML = `<div class="disabled-note">Lỗi truy vấn: ${escapeHtml(String(e))}</div>`; }
}
function bail(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml((r.error && r.error.message) || 'Lỗi truy vấn')}</div>`; }
function disabledNote(r) { $('analytics-panel').innerHTML = `<div class="disabled-note">${escapeHtml(r.message || 'Cần chọn một trình duyệt.')}</div>`; }

function thRow(t) { return `<tr><td>≥ ${fmtOdd(t.threshold)}</td><td>${cnt(t.reachedCount)}</td><td class="${nCls(t.sampleCount)}">${cnt(t.sampleCount)}</td><td>${pct(t.observedRate)}</td><td class="ci">${t.observedRate == null ? '—' : ciBand(t.ci95Low, t.ci95High)}</td></tr>`; }
function jpTheadCols(ranges) { return ranges.map((r) => `<th>${escapeHtml(r.label)}</th>`).join(''); }

function renderOverview(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  const a = r.all;
  let html = `<div class="cards">` +
    `<div class="card"><div class="c-label">Số vòng</div><div class="c-value">${cnt(a.n)}</div></div>` +
    `<div class="card"><div class="c-label">Trung vị ODD</div><div class="c-value">${fmtOdd(a.medianMaxOdd)}</div></div>` +
    `<div class="card"><div class="c-label">P90</div><div class="c-value">${fmtOdd(a.p90)}</div></div>` +
    `<div class="card"><div class="c-label">P95</div><div class="c-value">${fmtOdd(a.p95)}</div></div>` +
    `<div class="card"><div class="c-label">P99</div><div class="c-value">${fmtOdd(a.p99)}</div></div></div>`;
  html += `<div class="section-h">Tỷ lệ quan sát theo ngưỡng (toàn bộ)</div>`;
  html += `<table class="atable"><thead><tr><th>Ngưỡng</th><th>Đạt</th><th>n</th><th>Tỷ lệ quan sát</th><th>95% CI</th></tr></thead><tbody>${a.thresholds.map(thRow).join('')}</tbody></table>`;
  // JACKPOT comparison (primary)
  html += `<div class="section-h">So sánh theo Jackpot (${jpBasisLabel(r.jackpotBasis)}) — phơi nhiễm + tỷ lệ quan sát</div>`;
  html += `<table class="atable"><thead><tr><th>Jackpot</th><th>Số vòng (phơi nhiễm)</th><th>%tập</th><th>Trung vị</th><th>≥2×</th><th>≥5×</th><th>≥10×</th><th>≥100×</th></tr></thead><tbody>`;
  for (const b of r.byRange) { const g = (x) => (b.thresholds.find((z) => z.threshold === x) || {}).observedRate; html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.exposureN)}">${cnt(b.exposureN)}</td><td>${pct(b.exposureShare)}</td><td>${fmtOdd(b.medianMaxOdd)}</td><td>${pct(g(2))}</td><td>${pct(g(5))}</td><td>${pct(g(10))}</td><td>${pct(g(100))}</td></tr>`; }
  html += `</tbody></table><div class="muted">Cột "phơi nhiễm" cho biết mỗi khoảng Jackpot có bao nhiêu vòng, tách bạch với số sự kiện và tỷ lệ.</div>`;
  $('analytics-panel').innerHTML = html;
}

function renderOdd(r) {
  if (r.error) return bail(r); setMatched(r.summary);
  let html = `<div class="section-h">ODD × Jackpot (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>ODD \\ Jackpot</th>${jpTheadCols(r.jackpotRanges)}</tr></thead><tbody>`;
  for (const ob of r.oddBuckets) {
    html += `<tr><td>${escapeHtml(ob.label)}</td>` + ob.cells.map((c) => `<td title="${cnt(c.count)} vòng">${c.observedRate == null ? '—' : pct(c.observedRate)}<span class="celln"> (${cnt(c.count)})</span></td>`).join('') + `</tr>`;
  }
  html += `<tr class="exposure-row"><td>Phơi nhiễm (số vòng)</td>` + r.jackpotRanges.map((c) => `<td class="${nCls(c.exposureN)}">${cnt(c.exposureN)}</td>`).join('') + `</tr>`;
  html += `</tbody></table><div class="muted">Mỗi ô = tỷ lệ vòng trong khoảng Jackpot đó rơi vào khoảng ODD (kèm số vòng). Hàng cuối = phơi nhiễm.</div>`;
  $('analytics-panel').innerHTML = html;
}

// Language-neutral engine enums → conservative user-facing Vietnamese (no prediction wording).
const EFFECT_VI = { STRONG: 'Mối liên hệ mạnh', MODERATE: 'Mối liên hệ trung bình', WEAK: 'Mối liên hệ yếu', NEGLIGIBLE: 'Mối liên hệ rất yếu', NONE: '—' };
const STAT_STATUS_VI = { INSUFFICIENT_SAMPLE: 'Chưa đủ dữ liệu', CONSTANT_INPUT: 'Giá trị không đổi', NUMERIC_FAILURE: 'Không tính được', ASSUMPTION_FAILED: 'Chưa đủ điều kiện kiểm định', NOT_APPLICABLE_FILTERED_TO_SINGLE_RANGE: 'Không áp dụng (đã lọc 1 khoảng)' };
const STABILITY_VI = { STABLE: 'Ổn định', MIXED: 'Chưa rõ ràng', UNSTABLE: 'Chưa ổn định theo thời gian', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu' };
const QUALITY_VI = { VERY_LOW: 'Rất ít dữ liệu', LOW: 'Ít dữ liệu', MODERATE: 'Vừa đủ', GOOD: 'Dồi dào' };
function effVi(effect, status) { return status && status !== 'OK' ? (STAT_STATUS_VI[status] || '—') : (EFFECT_VI[effect] || '—'); }

// Compact "Phân tích thống kê" — effect size FIRST, p-value last (never a success badge).
function renderStatsBlock(st) {
  if (!st || st.error) return '';
  const sp = st.correlation.spearman, kd = st.correlation.kendall, ct = st.contingency, kw = st.distribution.kruskal;
  const card = (title, big, sub, n) => `<div class="stat-card"><div class="c-label">${title}</div><div class="c-value">${big}</div><div class="c-sub">${sub}</div>${n != null ? `<div class="c-sub">${AFmt.sampleN(n)}</div>` : ''}</div>`;
  const corrBig = sp.status === 'OK' ? 'ρ = ' + fx(sp.rho, 2) : '—';
  const vBig = ct.status === 'OK' ? 'V = ' + fx(ct.cramersV, 2) : '—';
  let html = `<div class="section-h">Phân tích thống kê <span class="muted">(chỉ thống kê lịch sử)</span></div>`;
  html += `<div class="stat-cards">` +
    card('Mối liên hệ Jackpot ↔ ODD', corrBig, effVi(sp.effect, sp.status), sp.n) +
    card('Độ mạnh phân nhóm', vBig, effVi(ct.effect, ct.status), ct.n) +
    card('Khác biệt phân phối', kw.status === 'OK' ? (kw.pValue < 0.05 ? 'Có khác biệt' : 'Không rõ') : '—', kw.status === 'OK' ? AFmt.pvalue(kw.pValue) : (STAT_STATUS_VI[kw.status] || '—'), kw.n) +
    card('Độ ổn định theo thời gian', STABILITY_VI[st.stability.status] || '—', st.stability.magnitudeSpread != null ? 'Biên độ ρ: ' + fx(st.stability.magnitudeSpread, 2) : '—', null) +
    `</div>`;
  // Details table — effect size / interpretation / n / significance / quality.
  const row = (metric, value, n, sig, eff, q) => `<tr><td>${metric}</td><td>${value}</td><td>${n == null ? '—' : cnt(n)}</td><td>${sig}</td><td>${eff}</td><td>${q || '—'}</td></tr>`;
  html += `<table class="atable stat-table"><thead><tr><th>Chỉ số</th><th>Giá trị</th><th>n</th><th>Ý nghĩa thống kê</th><th>Hiệu ứng</th><th>Chất lượng mẫu</th></tr></thead><tbody>`;
  html += row('Spearman ρ', sp.status === 'OK' ? fx(sp.rho, 3) : '—', sp.n, sp.status === 'OK' ? AFmt.pvalue(sp.pValue) : (STAT_STATUS_VI[sp.status] || '—'), effVi(sp.effect, sp.status), QUALITY_VI[st.quality]);
  html += row('Kendall τ', kd.status === 'OK' ? fx(kd.tau, 3) : '—', kd.n, kd.status === 'OK' ? AFmt.pvalue(kd.pValue) : (STAT_STATUS_VI[kd.status] || '—'), effVi(kd.effect, kd.status), QUALITY_VI[st.quality]);
  html += row('Chi-square', ct.status === 'OK' || ct.status === 'ASSUMPTION_FAILED' ? fx(ct.chiSquare, 2) + (ct.df != null ? ' (df ' + ct.df + ')' : '') : '—', ct.n, ct.status === 'OK' ? AFmt.pvalue(ct.pValue) : (STAT_STATUS_VI[ct.status] || '—'), effVi(ct.effect, ct.status), null);
  html += row('Cramér V', ct.status === 'OK' ? fx(ct.cramersV, 3) : '—', ct.n, '—', effVi(ct.effect, ct.status), null);
  html += row('Kruskal-Wallis', kw.status === 'OK' ? 'H = ' + fx(kw.H, 2) + (kw.df != null ? ' (df ' + kw.df + ')' : '') : '—', kw.n, kw.status === 'OK' ? AFmt.pvalue(kw.pValue) : (STAT_STATUS_VI[kw.status] || '—'), '—', null);
  html += `</tbody></table>`;
  html += `<div class="muted" title="p-value nhỏ cho biết dữ liệu khó phù hợp với giả thuyết không có mối liên hệ; nó không cho biết hiệu ứng mạnh.">p-value nhỏ ≠ mối liên hệ mạnh. Ưu tiên đọc hiệu ứng và cỡ mẫu (n) trước p-value. Đây là phân tích dữ liệu lịch sử, không suy ra kết quả tương lai.</div>`;
  return html;
}

function renderJackpot(ov, delta, stats) {
  if (ov.error) return bail(ov); setMatched(ov.summary);
  let html = `<div class="section-h">Khoảng Jackpot × ODD (${jpBasisLabel(ov.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Jackpot</th><th>n</th><th>%tập</th><th>Trung vị</th><th>P90</th><th>≥2×</th><th>≥5×</th><th>≥10×</th><th>≥50×</th><th>≥100×</th><th>TG TB</th></tr></thead><tbody>`;
  for (const b of ov.byRange) { const g = (x) => (b.thresholds.find((z) => z.threshold === x) || {}).observedRate; html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.exposureN)}">${cnt(b.exposureN)}</td><td>${pct(b.exposureShare)}</td><td>${fmtOdd(b.medianMaxOdd)}</td><td>${fmtOdd(b.p90)}</td><td>${pct(g(2))}</td><td>${pct(g(5))}</td><td>${pct(g(10))}</td><td>${pct(g(50))}</td><td>${pct(g(100))}</td><td>${dur(b.avgDurationMs)}</td></tr>`; }
  html += `</tbody></table>`;
  if (delta && !delta.error) {
    html += `<div class="section-h">Chênh lệch Jackpot trong vòng × ODD <span class="muted">(nhóm cấu hình được; ${cnt(delta.summary.withDelta)}/${cnt(delta.summary.matchedRounds)} có dữ liệu)</span></div>`;
    html += `<table class="atable"><thead><tr><th>Nhóm</th><th>n</th><th>Trung vị ODD</th><th>≥2×</th><th>≥5×</th><th>≥10×</th></tr></thead><tbody>`;
    for (const g of delta.byGroup) html += `<tr><td>${escapeHtml(g.label)}</td><td class="${nCls(g.n)}">${cnt(g.n)}</td><td>${fmtOdd(g.median)}</td><td>${pct(g.rate2)}</td><td>${pct(g.rate5)}</td><td>${pct(g.rate10)}</td></tr>`;
    html += `</tbody></table>`;
  }
  html += renderStatsBlock(stats);
  html += renderForwardSection();
  $('analytics-panel').innerHTML = html;
  wireForward();
}

// ---- Forward Research V1 (subordinate research area; NOT a betting/action surface) ----
let fwdStage = 'ROUND_OPEN';
let fwdTarget = 'reached_2x';
const FWD_TARGETS = { reached_2x: 2, reached_5x: 5, reached_10x: 10 };
const FWD_CONCLUSION_VI = { NO_STABLE_FORWARD_VALUE: 'Không có cải thiện ổn định ngoài mẫu so với mức nền', SMALL_STABLE_FORWARD_VALUE: 'Có cải thiện nhỏ, ổn định ngoài mẫu (mức độ nhỏ)' };
const FWD_REASON_VI = { NO_OUT_OF_SAMPLE_IMPROVEMENT: 'Không cải thiện so với mức nền', TEMPORAL_INSTABILITY: 'Không ổn định theo thời gian', POOR_CALIBRATION: 'Hiệu chỉnh xác suất kém' };
const FWD_STATUS_VI = { INSUFFICIENT_DATA: 'Chưa đủ dữ liệu', INSUFFICIENT_POSITIVES: 'Chưa đủ sự kiện dương', OK: '' };
const FWD_STABILITY_VI = { STABLE: 'Ổn định', MIXED: 'Chưa rõ ràng', UNSTABLE: 'Không ổn định', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu' };

function renderForwardSection() {
  const opt = (v, l, sel) => `<option value="${v}"${sel === v ? ' selected' : ''}>${l}</option>`;
  return `<div class="section-h" style="margin-top:18px">Nghiên cứu Forward <span class="muted">(ngoài mẫu · chỉ dùng cho nghiên cứu)</span></div>` +
    `<div class="metric-switch">` +
    `<label class="fwd-lab">Giai đoạn <select id="fwd-stage">${opt('ROUND_OPEN', 'Lúc mở vòng', fwdStage)}${opt('ROUND_LOCK', 'Lúc khóa', fwdStage)}</select></label>` +
    `<label class="fwd-lab">Mục tiêu <select id="fwd-target">${opt('reached_2x', '≥2×', fwdTarget)}${opt('reached_5x', '≥5×', fwdTarget)}${opt('reached_10x', '≥10×', fwdTarget)}</select></label>` +
    `<button id="fwd-run" class="mbtn">Chạy nghiên cứu</button></div>` +
    `<div id="fwd-result" class="muted">Chọn giai đoạn/mục tiêu rồi bấm "Chạy nghiên cứu". Phân tích dùng dữ liệu lịch sử chia theo thời gian (train/validation/test) và kiểm tra ngoài mẫu.</div>`;
}
function wireForward() {
  const btn = $('fwd-run'); if (!btn) return;
  btn.onclick = () => runForward();
  const ss = $('fwd-stage'); if (ss) ss.onchange = () => { fwdStage = ss.value; };
  const ts = $('fwd-target'); if (ts) ts.onchange = () => { fwdTarget = ts.value; };
}
async function runForward() {
  const box = $('fwd-result'); if (!box) return;
  box.innerHTML = '<span class="muted">Đang chạy nghiên cứu…</span>';
  const target = { name: fwdTarget, threshold: FWD_TARGETS[fwdTarget] };
  const r = await api.forward.run({ modelStage: fwdStage, target, browserId: selectedId || null });
  box.innerHTML = renderForwardResult(r);
}
function renderForwardResult(r) {
  if (!r || r.error) return `<div class="disabled-note">${escapeHtml((r && r.error && r.error.message) || 'Lỗi nghiên cứu')}</div>`;
  const leak = `Kiểm tra rò rỉ: <b class="${r.leakageAudit && r.leakageAudit.pass ? 'ms-yes' : 'ms-no'}">${r.leakageAudit && r.leakageAudit.pass ? 'ĐẠT' : 'KHÔNG ĐẠT'}</b>`;
  if (r.status !== 'OK') {
    return `<div class="fwd-summary"><div class="muted">${FWD_STATUS_VI[r.status] || r.status} — n=${cnt(r.n)}, trình duyệt=${cnt(r.browsers)}. ${leak}.</div>` +
      `<div class="muted">Nghiên cứu forward cần đủ số vòng và sự kiện dương theo thời gian; hiện chưa đủ để đánh giá ngoài mẫu.</div></div>`;
  }
  const t = r.testMetrics, b = r.baseline.test;
  const card = (l, v, s) => `<div class="stat-card"><div class="c-label">${l}</div><div class="c-value">${v}</div>${s ? `<div class="c-sub">${s}</div>` : ''}</div>`;
  let html = `<div class="stat-cards">` +
    card('Mẫu (train/val/test)', `${cnt(r.split.train.n)} / ${cnt(r.split.validation.n)} / ${cnt(r.split.test.n)}`, `Tỷ lệ nền test: ${pct(t.prevalence)}`) +
    card('Brier (nền → mô hình)', `${fx(b.brier, 3)} → ${fx(t.brier, 3)}`, `Δ = ${fx(r.deltaBrierTest, 4)}`) +
    card('ROC AUC (test)', fx(t.auc, 3), `PR AUC: ${fx(t.prAuc, 3)}` + (r.aucCI && r.aucCI.status === 'OK' ? ` · CI ${fx(r.aucCI.low, 2)}–${fx(r.aucCI.high, 2)}` : '')) +
    card('Ổn định theo thời gian', FWD_STABILITY_VI[r.stability.status] || r.stability.status, leak) +
    `</div>`;
  // Walk-forward folds.
  html += `<div class="section-h">Kiểm định trượt theo thời gian (walk-forward)</div>`;
  html += `<table class="atable stat-table"><thead><tr><th>Fold</th><th>Train n</th><th>Test n</th><th>Tỷ lệ nền</th><th>AUC</th><th>Brier</th><th>Δ Brier</th></tr></thead><tbody>`;
  for (const f of r.walkForward) html += `<tr><td>${f.fold}</td><td>${cnt(f.trainN)}</td><td>${cnt(f.testN)}</td><td>${pct(f.prevalence)}</td><td>${fx(f.auc, 3)}</td><td>${fx(f.brier, 3)}</td><td>${fx(f.deltaBrier, 4)}</td></tr>`;
  html += `</tbody></table>`;
  // Calibration (only bins with enough n).
  const cbins = (t.calibration || []).filter((c) => c.n >= 1);
  if (cbins.length) {
    html += `<div class="section-h">Hiệu chỉnh xác suất (test)</div><table class="atable stat-table"><thead><tr><th>Khoảng dự tính</th><th>n</th><th>TB dự tính</th><th>Tỷ lệ quan sát</th></tr></thead><tbody>`;
    for (const c of cbins) html += `<tr><td>${pct(c.lo)}–${pct(c.hi)}</td><td class="${nCls(c.n)}">${cnt(c.n)}</td><td>${pct(c.meanPredicted)}</td><td>${pct(c.observedRate)}</td></tr>`;
    html += `</tbody></table>`;
  }
  // Conclusion (effect + stability first; not a p-value badge, not a recommendation).
  const reasons = (r.conclusion.reasons || []).map((x) => FWD_REASON_VI[x] || x).join('; ');
  html += `<div class="fwd-conclusion"><b>Kết luận:</b> ${FWD_CONCLUSION_VI[r.conclusion.status] || r.conclusion.status}${reasons ? ' — ' + reasons : ''}. ` +
    `<span class="muted">Đây là bằng chứng nghiên cứu lịch sử ngoài mẫu, chỉ dùng cho mục đích nghiên cứu.</span></div>`;
  return html;
}

// "Thời gian" section merges two metrics behind a selector (spec §4): the hour × Jackpot
// rate view, and the (former "Tốc độ ODD") time-to-threshold × Jackpot view. Jackpot context
// is preserved in both. `timeMetric` remembers the user's choice across re-renders.
async function renderTimeTab(f, jp) {
  const sw = `<div class="metric-switch">` +
    `<button class="mbtn ${timeMetric === 'hour' ? 'active' : ''}" data-tm="hour">Theo giờ</button>` +
    `<button class="mbtn ${timeMetric === 'timing' ? 'active' : ''}" data-tm="timing">Thời gian đạt ODD</button></div>`;
  let body;
  if (timeMetric === 'timing') { const r = await api.report.timing(f, jp, 'median'); if (r.error) return bail(r); setMatched(r.summary); body = buildTiming(r); }
  else { const r = await api.report.time(f, jp); if (r.error) return bail(r); setMatched(r.summary); body = buildTime(r); }
  $('analytics-panel').innerHTML = sw + body;
  for (const b of document.querySelectorAll('#analytics-panel .mbtn')) b.onclick = () => { timeMetric = b.dataset.tm; renderReport(); };
}

function buildTime(r) {
  let html = `<div class="section-h">Giờ trong ngày × Jackpot — tỷ lệ ≥2× (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Giờ</th>${jpTheadCols(r.ranges)}</tr></thead><tbody>`;
  for (const h of r.hours) {
    if (h.byRange.every((b) => b.n === 0)) continue;
    html += `<tr><td>${String(h.hour).padStart(2, '0')}:00</td>` + h.byRange.map((b) => `<td title="${cnt(b.n)} vòng">${b.n ? pct(b.rate2) : '—'}<span class="celln"> (${cnt(b.n)})</span></td>`).join('') + `</tr>`;
  }
  html += `</tbody></table><div class="muted">Ô = tỷ lệ ≥2× trong giờ đó cho từng khoảng Jackpot (kèm số vòng). Giờ theo giờ máy.</div>`;
  return html;
}

function buildTiming(r) {
  let html = `<div class="section-h">Thời gian đạt ngưỡng × Jackpot — trung vị (loại trừ vòng bị cắt) (${jpBasisLabel(r.jackpotBasis)})</div>`;
  html += `<table class="atable"><thead><tr><th>Ngưỡng</th><th>Tất cả (n)</th>${jpTheadCols(r.ranges)}</tr></thead><tbody>`;
  for (const t of r.thresholds) {
    html += `<tr><td>≥ ${fmtOdd(t.threshold)}</td><td>${t.all.statMs == null ? '—' : dur(t.all.statMs)} <span class="celln">(${cnt(t.all.timingN)})</span></td>` +
      t.byRange.map((b) => `<td>${b.statMs == null ? '—' : dur(b.statMs)}<span class="celln"> (${cnt(b.timingN)})</span></td>`).join('') + `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function renderStreakGap(streak, gap) {
  if (streak.disabled || gap.disabled) return disabledNote(streak.disabled ? streak : gap);
  if (streak.error) return bail(streak); setMatched(streak.summary);
  let html = `<div class="section-h">Chuỗi (số vòng liên tiếp dưới ngưỡng)</div>`;
  html += `<table class="atable"><thead><tr><th>Dưới</th><th>Hiện tại</th><th>Dài nhất</th><th>Số chuỗi đã kết thúc</th><th>Trung vị</th></tr></thead><tbody>`;
  for (const s of streak.overall) html += `<tr><td>&lt; ${fmtOdd(s.threshold)}</td><td>${cnt(s.currentStreak)}</td><td>${cnt(s.longestStreak)}</td><td>${cnt(s.completedStreakCount)}</td><td>${fx(s.medianCompletedStreak, 1)}</td></tr>`;
  html += `</tbody></table>`;
  const ctx = streak.context;
  html += `<div class="section-h">Jackpot của các vòng bên trong chuỗi &lt;2×</div>`;
  html += `<table class="atable"><thead><tr><th>Ngữ cảnh</th>${ctx.insideStreaks.map((b) => `<th>${escapeHtml(b.label)}</th>`).join('')}</tr></thead><tbody>`;
  html += `<tr><td>Trong chuỗi</td>${ctx.insideStreaks.map((b) => `<td>${cnt(b.n)}</td>`).join('')}</tr>`;
  html += `<tr><td>Đầu chuỗi</td>${ctx.atStart.map((b) => `<td>${cnt(b.n)}</td>`).join('')}</tr>`;
  html += `<tr><td>Cuối chuỗi</td>${ctx.atEnd.map((b) => `<td>${cnt(b.n)}</td>`).join('')}</tr></tbody></table>`;
  html += `<div class="section-h">Khoảng cách giữa các vòng ODD cao</div>`;
  html += `<table class="atable"><thead><tr><th>≥</th><th>Số lần</th><th>Khoảng hiện tại</th><th>Trung vị</th><th>P90</th></tr></thead><tbody>`;
  for (const g of gap.overall) html += `<tr><td>≥ ${fmtOdd(g.threshold)}</td><td>${cnt(g.occurrences)}</td><td>${g.hasPriorOccurrence ? cnt(g.currentGapRounds) : cnt(g.currentGapRounds) + ' (chưa có)'}</td><td>${fx(g.medianGapRounds, 0)}</td><td>${fx(g.p90, 0)}</td></tr>`;
  html += `</tbody></table>`;
  const ex10 = gap.exposure.find((e) => e.threshold === 10);
  if (ex10) {
    html += `<div class="section-h">Phơi nhiễm ≥10× theo Jackpot</div>`;
    html += `<table class="atable"><thead><tr><th>Jackpot</th><th>Số vòng đủ điều kiện</th><th>Số lần ≥10×</th><th>Tỷ lệ quan sát</th></tr></thead><tbody>`;
    for (const b of ex10.byRange) html += `<tr><td>${escapeHtml(b.label)}</td><td class="${nCls(b.eligibleN)}">${cnt(b.eligibleN)}</td><td>${cnt(b.occurrences)}</td><td>${pct(b.observedRate)}</td></tr>`;
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
    tr.innerHTML = `<td>${cnt(r.sequenceNumber)}</td><td>${fmtTime(tsIso(r.openedAtMs))}</td><td>${fmtNum(r.sid)}</td><td>${fmtOdd(r.maxOdd)}</td><td>${fmtJp(r.jackpotAtOpen)}</td><td>${fmtJp(r.jackpotAtEnd)}</td><td>${dur(r.durationMs)}</td><td><span class="cmpl cmpl-${r.completeness}">${r.completeness}</span></td>`;
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
  let html = section('Định danh & vòng đời', kv([['SID', fmtNum(r.sid)], ['Trạng thái', r.completeness], ['Mở', fmtTime(tsIso(r.openedAtMs))], ['Kết thúc', fmtTime(tsIso(r.endedAtMs))], ['Thời lượng', dur(r.durationMs)]]));
  html += section('ODD', kv([['Đầu', fmtOdd(r.firstOdd)], ['Cuối', fmtOdd(r.lastOdd)], ['Max', fmtOdd(r.maxOdd)], ['Số mẫu', cnt(r.oddSampleCount)]]));
  html += section('Biểu đồ ODD', spark(d.oddSamples.map((s) => s.odd), false));
  html += section('Jackpot', kv([['Mở', fmtJp(r.jackpotAtOpen)], ['Kết thúc', fmtJp(r.jackpotAtEnd)], ['Min', fmtJp(r.jackpotMin)], ['Max', fmtJp(r.jackpotMax)], ['Số mẫu', cnt(r.jackpotSampleCount)]]));
  if (d.jackpotSamples.length) html += section('Biểu đồ Jackpot', spark(d.jackpotSamples.map((s) => s.jackpot), true));
  html += section('Mốc ngưỡng' + (d.metrics && d.metrics.timingCensored ? ' (thời gian bị cắt — vòng thu thập dở)' : ''), milestones(d.metrics));
  html += `<details class="tech"><summary>Bằng chứng kỹ thuật (${d.relatedRawEvents.length})</summary>${rawTable(d.relatedRawEvents)}</details>`;
  $('detail-body').innerHTML = html; $('detail-drawer').classList.remove('hidden');
}
function milestones(m) { if (!m || !m.thresholds) return '<div class="muted">—</div>'; return '<table class="milestones">' + Object.keys(m.thresholds).map((t) => { const x = m.thresholds[t]; return `<tr><td>${fmtOdd(t)}</td><td>${x.reached ? '<span class="ms-yes">đạt' + (x.timeToMs != null ? ' · ' + dur(x.timeToMs) : '') + '</span>' : '<span class="ms-no">không đạt</span>'}</td></tr>`; }).join('') + '</table>'; }
function rawTable(events) { if (!events.length) return '<div class="muted">Không có.</div>'; return '<div class="events-table-wrap"><table class="events-table"><thead><tr><th>Thời gian</th><th>Hướng</th><th>CMD</th><th>Type</th><th>SID</th><th>ODD</th><th>JP</th></tr></thead><tbody>' + events.map((e) => `<tr><td>${fmtTime(tsIso(e.timestampMs))}</td><td class="dir-${e.direction}">${e.direction}</td><td>${fmtNum(e.cmd)}</td><td>${escapeHtml(e.type || '')}</td><td>${fmtNum(e.sid)}</td><td>${e.odd == null ? '—' : fmtOdd(e.odd)}</td><td>${fmtJp(e.jackpot)}</td></tr>`).join('') + '</tbody></table></div>'; }

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
    let h = section('Khung WebSocket', kv([['Hướng', ev.direction === 'SEND' ? 'WEBSITE SEND' : 'RECV (server)'], ['Thời gian', fmtTime(tsIso(ev.timestamp_ms))], ['CMD', fmtNum(ev.cmd)], ['Type', ev.event_type], ['SID', fmtNum(ev.sid)], ['ODD', ev.odd == null ? '—' : fmtOdd(ev.odd)], ['Jackpot', fmtJp(ev.jackpot)]]));
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
  const cards = [['Phiên bản schema', info.schemaVersion], ['Kích thước', F.bytes(info.sizeBytes)], ['Phiên thu thập', cnt(info.sessions)], ['Request mạng', cnt(info.networkRequests)], ['Response', cnt(info.networkResponses)], ['Body', cnt(info.networkBodies)], ['WS kết nối', cnt(info.wsConnections)], ['WS sự kiện', cnt(info.wsEvents)], ['Sự kiện giao thức', cnt(info.rawEvents)], ['Vòng', cnt(info.rounds)], ['Mẫu ODD', cnt(info.oddSamples)], ['Mẫu Jackpot', cnt(info.jackpotSamples)]];
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

// ===========================================================================
// NGHIÊN CỨU & ĐÁNH GIÁ THUẬT TOÁN (Algorithm Research & Evaluation)
// Descriptive, out-of-sample research evidence only. Registry-driven, fingerprinted,
// persisted & versioned. NOT a betting/action surface and NOT a recommendation.
// ===========================================================================
let rsSub = 'overview';
let rsScope = '';
let rsSel = { algorithmId: null, modelStage: 'ROUND_OPEN', target: 'reached_2x' };
let rsAlgos = null;           // cached registry view
let rsTargets = null;
let rsCompareCell = { modelStage: 'ROUND_OPEN', target: 'reached_2x' };

const RS_STAGE_VI = { ROUND_OPEN: 'Lúc mở vòng', ROUND_LOCK: 'Lúc khóa' };
const RS_TARGET_VI = { reached_2x: '≥2×', reached_5x: '≥5×', reached_10x: '≥10×', reached_20x: '≥20×', reached_50x: '≥50×', reached_100x: '≥100×' };
const RS_QUALITY_VI = {
  NOT_EVALUATED: 'Chưa đánh giá', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu', INVALID: 'Không hợp lệ (rò rỉ)',
  NO_IMPROVEMENT: 'Không cải thiện so với nền', SMALL_UNSTABLE_IMPROVEMENT: 'Cải thiện nhỏ, chưa ổn định',
  SMALL_STABLE_IMPROVEMENT: 'Cải thiện nhỏ, ổn định', MATERIAL_STABLE_IMPROVEMENT: 'Cải thiện rõ rệt, ổn định',
};
const RS_QUALITY_CLS = { MATERIAL_STABLE_IMPROVEMENT: 'ms-yes', SMALL_STABLE_IMPROVEMENT: 'ms-yes', NO_IMPROVEMENT: '', INVALID: 'ms-no', INSUFFICIENT_DATA: '' };
const RS_STABILITY_VI = { STABLE: 'Ổn định', MIXED: 'Chưa rõ ràng', UNSTABLE: 'Không ổn định', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu' };
const RS_DRIFT_VI = { NO_MATERIAL_CHANGE: 'Không đổi đáng kể', POSSIBLE_DRIFT: 'Có thể biến động', MATERIAL_DEGRADATION: 'Suy giảm đáng kể', IMPROVEMENT: 'Cải thiện', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu' };
const RS_DRIFT_CLS = { MATERIAL_DEGRADATION: 'ms-no', POSSIBLE_DRIFT: 'warn', IMPROVEMENT: 'ms-yes', NO_MATERIAL_CHANGE: '', INSUFFICIENT_DATA: '' };
const RS_READY_VI = { READY: 'Đủ dữ liệu', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu', INSUFFICIENT_POSITIVES: 'Chưa đủ sự kiện dương', FEATURE_UNAVAILABLE: 'Thiếu biến', INVALID: 'Không hợp lệ' };
const RS_STATUS_VI = { OK: 'OK', INSUFFICIENT_DATA: 'Chưa đủ dữ liệu', INSUFFICIENT_POSITIVES: 'Chưa đủ sự kiện dương', INVALID: 'Không hợp lệ', MODEL_FAILED: 'Mô hình không hội tụ / lỗi số học' };
// ---- V2 plain-language maps (simple-first UX; internal enums never shown raw) ----
const RS_FAMILY_VI = { BASELINE: 'Mốc cơ bản', LOGISTIC_REGRESSION: 'Tuyến tính (logistic)', SPLINE: 'Phi tuyến trơn (spline)', DECISION_TREE: 'Cây quyết định' };
const RS_COMPLEXITY_VI = { BASELINE: 'Rất đơn giản', LINEAR: 'Đơn giản (tuyến tính)', NONLINEAR_ADDITIVE: 'Trung bình (phi tuyến)', NONLINEAR_TREE: 'Trung bình (cây)' };
const RS_INCR_VI = {
  N_A: '—', NOT_READY: 'Chưa đánh giá được', NO_INCREMENTAL_VALUE: 'Không tốt hơn mô hình đơn giản',
  POSSIBLE_INCREMENTAL_VALUE: 'Có thể tốt hơn đôi chút', STABLE_INCREMENTAL_VALUE: 'Tốt hơn ổn định so với mô hình đơn giản',
  UNSTABLE: 'Tốt hơn nhưng chưa ổn định', INVALID: 'Không hợp lệ (rò rỉ)',
};
const RS_INCR_CLS = { STABLE_INCREMENTAL_VALUE: 'ms-yes', POSSIBLE_INCREMENTAL_VALUE: 'warn', UNSTABLE: 'warn', NO_INCREMENTAL_VALUE: '', INVALID: 'ms-no', NOT_READY: '', 'N_A': '' };
// Metric translation (§ metric-translation): user-friendly label first, raw value smaller (§ advanced details).
const RS_METRIC_VI = { brier: 'Sai số xác suất', calibration: 'Độ khớp xác suất', stability: 'Độ ổn định theo thời gian', leakage: 'Kiểm tra dữ liệu tương lai', baseline: 'Mốc so sánh cơ bản' };
// Plain result status (Level-1): one phrase a non-technical user understands.
function rsPlainResult(r) {
  if (!r) return { icon: '○', label: 'Chưa đánh giá', cls: '' };
  if (r.leakageStatus && r.leakageStatus !== 'PASS') return { icon: '!', label: 'Không hợp lệ (dữ liệu tương lai)', cls: 'ms-no' };
  if (r.status && r.status !== 'OK') {
    if (r.status === 'MODEL_FAILED') return { icon: '!', label: 'Mô hình chưa chạy được', cls: 'warn' };
    return { icon: '○', label: 'Chưa đủ dữ liệu', cls: '' };
  }
  const q = r.quality && r.quality.status ? r.quality.status : r.quality;
  const map = {
    MATERIAL_STABLE_IMPROVEMENT: { icon: '✓', label: 'Có cải thiện rõ, ổn định', cls: 'ms-yes' },
    SMALL_STABLE_IMPROVEMENT: { icon: '✓', label: 'Có cải thiện nhỏ, ổn định', cls: 'ms-yes' },
    SMALL_UNSTABLE_IMPROVEMENT: { icon: '!', label: 'Kết quả chưa ổn định', cls: 'warn' },
    NO_IMPROVEMENT: { icon: '○', label: 'Không tốt hơn mốc cơ bản', cls: '' },
    INVALID: { icon: '!', label: 'Không hợp lệ', cls: 'ms-no' },
    INSUFFICIENT_DATA: { icon: '○', label: 'Chưa đủ dữ liệu', cls: '' },
  };
  return map[q] || { icon: '○', label: RS_QUALITY_VI[q] || '—', cls: '' };
}
// Plain-language "how much more data" hint (§ data-readiness UX); no false precision.
function rsDataHint(rd) {
  if (!rd) return '';
  if (rd.status === 'READY') return 'Đã đủ dữ liệu để đánh giá.';
  const needRounds = Math.max(Math.ceil((rd.trainDeficit || 0) / 0.6), Math.ceil((rd.testDeficit || 0) / 0.2));
  if (needRounds > 0) return `Cần thêm khoảng ${needRounds} vòng hoàn chỉnh trước khi đánh giá thuật toán này.`;
  if (rd.positiveDeficit > 0) return `Chưa đủ số vòng đạt ngưỡng để đánh giá đáng tin cậy (thiếu ~${rd.positiveDeficit} sự kiện dương).`;
  return 'Chưa đủ dữ liệu.';
}
const RS_DECISION_VI = RS_INCR_VI; // research decision shares the incremental-value vocabulary
const leakVi = (s) => (s === 'PASS' ? '<b class="ms-yes">ĐẠT</b>' : '<b class="ms-no">KHÔNG ĐẠT</b>');
const rsTime = (ms) => (ms ? new Date(ms).toLocaleString([], { hour12: false }) : '—');
const rsFp = (s) => (s ? `<code class="rs-fp">${escapeHtml(s)}</code>` : '—');

for (const b of document.querySelectorAll('#view-research .subtab')) b.addEventListener('click', () => { rsSub = b.dataset.rs; for (const s of document.querySelectorAll('#view-research .subtab')) s.classList.toggle('active', s === b); renderResearch(); });
$('rs-run-all').addEventListener('click', async () => { const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang chạy đánh giá toàn bộ thuật toán × giai đoạn × mục tiêu…</div>'; await api.research.evaluateAll({ browserScope: rsScope || null }); renderResearch(); });
$('rs-scope').addEventListener('change', () => { rsScope = $('rs-scope').value; renderResearch(); });

async function loadResearch() {
  if (!rsAlgos) { const r = await api.research.algorithms(); rsAlgos = r.algorithms || []; rsTargets = r.targets || []; if (!rsSel.algorithmId && rsAlgos.length) rsSel.algorithmId = rsAlgos[0].algorithmId; }
  // scope options mirror the browser rail
  const sc = $('rs-scope'); const cur = rsScope;
  sc.innerHTML = '<option value="">Tất cả trình duyệt</option>' + browsers.map((b) => `<option value="${escapeHtml(b.browserId)}"${cur === b.browserId ? ' selected' : ''}>${escapeHtml(b.displayName)}</option>`).join('');
  renderResearch();
}

function renderResearch() {
  if (rsSub === 'overview') return rsRenderOverview();
  if (rsSub === 'algorithms') return rsRenderAlgorithms();
  if (rsSub === 'compare') return rsRenderCompare();
  if (rsSub === 'history') return rsRenderHistory();
  return rsRenderOverview();
}

// ---- Overview — LEVEL 1 simple-first (plain conclusion → evidence → technical) ----
async function rsRenderOverview() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  const o = await api.research.overview();
  if (o.error) { box.innerHTML = bailText(o); return; }
  const cov = o.coverage || {};
  // 1) A few plain-language primary cards — understandable in under 10 seconds.
  const primary = [
    ['Thuật toán đang theo dõi', cnt(o.registeredAlgorithms)],
    ['Đủ dữ liệu để đánh giá', `${cnt(o.dataReadyCells)} / ${cnt(o.readyCellsTotal)}`],
    ['Có cải thiện ổn định', cnt(o.stableImprovement)],
    ['Chưa đủ dữ liệu', cnt(o.insufficientData)],
    ['Cảnh báo giảm hiệu năng', cnt((o.driftWarnings || []).length)],
  ];
  let html = `<div class="section-h">Tổng quan</div><div class="cards">` + primary.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div></div>`).join('') + '</div>';
  if (!o.evaluatedExperiments) html += `<div class="fwd-conclusion muted">Chưa có lần đánh giá nào. Khi dữ liệu đủ, bấm "Đánh giá lại" để hệ thống chạy đánh giá mọi thuật toán trên dữ liệu hiện có.</div>`;

  // 2) Compact algorithm list with PLAIN statuses (no internal enum names).
  const mon = await api.research.monitoring();
  const latestByKey = {}; if (Array.isArray(mon)) for (const m of mon) latestByKey[`${m.algorithmId}|${m.modelStage}|${m.target}`] = m;
  html += `<div class="section-h">Thuật toán</div>`;
  html += `<table class="atable"><thead><tr><th>Tên</th><th>Loại</th><th>Trạng thái dữ liệu</th><th>Kết quả hiện tại</th><th>Lần đánh giá gần nhất</th></tr></thead><tbody>`;
  for (const a of rsAlgos) {
    const m = latestByKey[`${a.algorithmId}|ROUND_OPEN|reached_2x`] || null;
    const lr = m ? m.latest : null;
    const pr = rsPlainResult(lr ? { status: lr.status, leakageStatus: lr.leakageStatus, quality: lr.quality } : null);
    const dataState = lr ? (lr.status === 'OK' ? '✓ Đủ dữ liệu' : '○ Chưa đủ dữ liệu') : '○ Chưa đánh giá';
    const expTag = a.experimental ? ' <span class="muted">(thử nghiệm)</span>' : '';
    html += `<tr><td><a href="#" data-algo="${escapeHtml(a.algorithmId)}">${escapeHtml(a.name)}</a>${expTag}</td><td>${RS_FAMILY_VI[a.family] || a.family}</td><td class="muted">${dataState}</td><td class="${pr.cls}">${pr.icon} ${pr.label}</td><td class="muted">${lr ? rsTime(lr.evaluatedAtMs) : '—'}</td></tr>`;
  }
  html += `</tbody></table>`;
  for (const el of []) void el;

  // 3) Family-level view (does a family consistently add value? — never ranked by best single run).
  const fam = await api.research.familyMonitoring();
  if (Array.isArray(fam) && fam.length) {
    html += `<div class="section-h">Theo nhóm thuật toán</div>`;
    html += `<table class="atable"><thead><tr><th>Nhóm</th><th>Ô đủ dữ liệu</th><th>Tốt hơn mô hình đơn giản (ổn định)</th><th>Chưa ổn định</th><th>Không tốt hơn</th></tr></thead><tbody>`;
    for (const f of fam) html += `<tr><td>${RS_FAMILY_VI[f.family] || f.family}</td><td>${cnt(f.realReadyCells)}</td><td class="${f.stableIncrementalCells ? 'ms-yes' : ''}">${cnt(f.stableIncrementalCells)}</td><td class="${f.unstableCells ? 'warn' : ''}">${cnt(f.unstableCells)}</td><td>${cnt(f.noIncrementalValueCells)}</td></tr>`;
    html += `</tbody></table>`;
  }

  // 4) Performance-degradation warnings (plain).
  if (o.driftWarnings && o.driftWarnings.length) {
    html += `<div class="section-h">↓ Cảnh báo giảm hiệu năng gần đây</div>`;
    html += `<table class="atable"><thead><tr><th>Thuật toán</th><th>Giai đoạn</th><th>Mục tiêu</th><th>Trạng thái</th></tr></thead><tbody>` + o.driftWarnings.map((d) => `<tr><td>${escapeHtml(d.algorithmId)}</td><td>${RS_STAGE_VI[d.modelStage] || d.modelStage}</td><td>${RS_TARGET_VI[d.target] || d.target}</td><td class="${RS_DRIFT_CLS[d.status] || ''}">${RS_DRIFT_VI[d.status] || d.status}</td></tr>`).join('') + `</tbody></table>`;
  }

  // 5) Collapsed technical details (coverage, readiness matrix, policy versions, batches).
  html += await rsOverviewTechnical(o, cov);
  html += `<div class="muted" style="margin-top:10px">Mọi kết quả là bằng chứng nghiên cứu lịch sử ngoài mẫu — mô tả và so sánh, không phải lời khuyên hành động.</div>`;
  box.innerHTML = html;
  for (const link of document.querySelectorAll('#rs-panel a[data-algo]')) link.onclick = (e) => { e.preventDefault(); rsSel.algorithmId = link.dataset.algo; rsSub = 'algorithms'; for (const s of document.querySelectorAll('#view-research .subtab')) s.classList.toggle('active', s.dataset.rs === 'algorithms'); renderResearch(); };
}

// Collapsed "Chi tiết kỹ thuật" for the overview (Level 3 — hidden until requested).
async function rsOverviewTechnical(o, cov) {
  const covCards = [['Vòng hoàn tất', cnt(cov.completeRounds)], ['Số trình duyệt', cnt(cov.browsers)], ['Từ', rsTime(cov.earliestMs)], ['Đến', rsTime(cov.latestMs)], ['Schema', cov.schemaVersion]];
  let t = `<div class="cards">` + covCards.map(([l, v]) => `<div class="card"><div class="c-label">${l}</div><div class="c-value">${escapeHtml(v)}</div></div>`).join('') + '</div>';
  // Readiness matrix (family-specific guards).
  const m = await api.research.readinessMatrix({ browserScope: rsScope || null });
  if (!m.error && m.cells) {
    t += `<div class="section-h">Chất lượng dữ liệu theo thuật toán × giai đoạn × mục tiêu</div>`;
    t += `<table class="atable"><thead><tr><th>Thuật toán</th><th>Giai đoạn</th><th>Mục tiêu</th><th>Trạng thái</th><th>Train n</th><th>Test n</th><th>Dương (train/test)</th><th>Thiếu</th></tr></thead><tbody>`;
    for (const c of m.cells) {
      const r = c.readiness; const ok = r.status === 'READY';
      const deficits = [];
      if (r.trainDeficit) deficits.push(`train −${cnt(r.trainDeficit)}`);
      if (r.testDeficit) deficits.push(`test −${cnt(r.testDeficit)}`);
      if (r.positiveDeficit) deficits.push(`dương −${cnt(r.positiveDeficit)}`);
      t += `<tr><td>${escapeHtml(c.algorithmId)}</td><td>${RS_STAGE_VI[c.modelStage] || c.modelStage}</td><td>${RS_TARGET_VI[c.target] || c.target}</td>` +
        `<td class="${ok ? 'ms-yes' : 'ms-no'}">${RS_READY_VI[r.status] || r.status}</td><td>${cnt(r.train ? r.train.n : null)}</td><td>${cnt(r.test ? r.test.n : null)}</td>` +
        `<td>${cnt(r.train ? r.train.positives : null)} / ${cnt(r.test ? r.test.positives : null)}</td><td class="muted">${deficits.join(', ') || '—'}</td></tr>`;
    }
    t += `</tbody></table>`;
  }
  // Batches + policy versions.
  const batches = await api.research.batches();
  if (Array.isArray(batches) && batches.length) {
    t += `<div class="section-h">Đợt đánh giá (cùng một ảnh chụp dữ liệu)</div>`;
    t += `<table class="atable"><thead><tr><th>Thời điểm</th><th>Phạm vi</th><th>Số ô</th><th>Số vân tay dữ liệu</th><th>Mã đợt</th></tr></thead><tbody>` +
      batches.slice(0, 12).map((b) => `<tr><td>${rsTime(b.createdAtMs)}</td><td>${b.browserScope || 'Tất cả'}</td><td>${cnt(b.cellCount)}</td><td>${cnt((b.datasetFingerprints || []).length)}</td><td><code class="rs-fp">${escapeHtml(b.batchKey)}</code></td></tr>`).join('') + `</tbody></table>`;
  }
  if (o.policyVersions) t += `<div class="muted">Phiên bản chính sách — chất lượng v${o.policyVersions.quality}, so sánh v${o.policyVersions.comparability}, vân tay v${o.policyVersions.fingerprint}, rò rỉ v${o.policyVersions.leakage}.</div>`;
  return `<details class="rs-tech"><summary>Chi tiết kỹ thuật</summary>${t}</details>`;
}

// ---- Algorithms list + detail (§49/§51 simple-first) ----
async function rsRenderAlgorithms() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  let html = `<div class="section-h">Thuật toán</div>`;
  html += `<table class="atable"><thead><tr><th>Tên</th><th>Loại</th><th>Độ phức tạp</th><th>Trạng thái</th></tr></thead><tbody>`;
  for (const a of rsAlgos) {
    const active = a.algorithmId === rsSel.algorithmId ? ' class="rs-row-active"' : '';
    const cap = a.deprecated ? 'Ngừng dùng' : (a.experimental ? 'Thử nghiệm' : 'Đang dùng');
    html += `<tr data-algo="${escapeHtml(a.algorithmId)}"${active}><td><a href="#" data-algo="${escapeHtml(a.algorithmId)}">${escapeHtml(a.name)}</a></td><td>${RS_FAMILY_VI[a.family] || a.family}</td><td class="muted">${RS_COMPLEXITY_VI[a.complexityClass] || a.complexityClass || '—'}</td><td class="muted">${cap}</td></tr>`;
  }
  html += `</tbody></table><div id="rs-algo-detail"></div>`;
  box.innerHTML = html;
  for (const a of document.querySelectorAll('#rs-panel a[data-algo]')) a.onclick = (e) => { e.preventDefault(); rsSel.algorithmId = a.dataset.algo; rsRenderAlgorithms(); };
  rsRenderAlgoDetail();
}

async function rsRenderAlgoDetail() {
  const host = $('rs-algo-detail'); if (!host) return;
  const a = rsAlgos.find((x) => x.algorithmId === rsSel.algorithmId); if (!a) return;
  const stageOpt = a.supportedStages.map((s) => `<option value="${s}"${rsSel.modelStage === s ? ' selected' : ''}>${RS_STAGE_VI[s] || s}</option>`).join('');
  const tgtOpt = rsTargets.map((t) => `<option value="${t.targetId}"${rsSel.target === t.targetId ? ' selected' : ''}>${RS_TARGET_VI[t.targetId] || t.targetId}</option>`).join('');
  // Top: name + plain-language explanation. One primary action on this screen: "Chạy đánh giá".
  let html = `<div class="section-h">${escapeHtml(a.name)} <span class="muted">· ${RS_FAMILY_VI[a.family] || a.family}</span></div>`;
  html += `<div class="muted" style="margin-bottom:6px">${escapeHtml(a.explanation || a.description)}</div>`;
  html += `<div class="fwd-controls"><label class="fwd-lab">Giai đoạn <select id="rs-d-stage">${stageOpt}</select></label>` +
    `<label class="fwd-lab">Mục tiêu <select id="rs-d-target">${tgtOpt}</select></label>` +
    `<button id="rs-d-run" class="btn-primary">Chạy đánh giá</button></div>`;
  html += `<div id="rs-d-result" class="muted">Chọn giai đoạn/mục tiêu rồi bấm "Chạy đánh giá". Hệ thống đánh giá ngoài mẫu (train/validation/test theo thời gian) và lưu lại kết quả.</div>`;
  host.innerHTML = html;
  $('rs-d-stage').onchange = (e) => { rsSel.modelStage = e.target.value; rsRenderAlgoDetail(); };
  $('rs-d-target').onchange = (e) => { rsSel.target = e.target.value; };
  $('rs-d-run').onclick = async () => {
    const rb = $('rs-d-result'); rb.innerHTML = '<div class="muted">Đang đánh giá…</div>';
    const res = await api.research.evaluate({ algorithmId: a.algorithmId, modelStage: rsSel.modelStage, target: rsSel.target, browserScope: rsScope || null });
    if (res.error) { rb.innerHTML = bailText(res); return; }
    rb.innerHTML = rsRenderEvaluation(res.evaluation, res.run, a);
  };
  // Auto-show the last saved evaluation for this cell if one exists (so the page isn't empty).
  const hist = await api.research.history({ algorithmId: a.algorithmId, target: rsSel.target, modelStage: rsSel.modelStage, browserScope: rsScope || null });
  if (Array.isArray(hist) && hist.length) {
    const full = await api.research.run(hist[hist.length - 1].runId);
    if (full && !full.error && full.resultJson) { const ev = JSON.parse(full.resultJson); ev.quality = ev.quality || { status: full.quality }; $('rs-d-result').innerHTML = rsRenderEvaluation(ev, { runId: full.runId, deduped: true }, a); }
  }
}

// Simple-first evaluation renderer: plain-language summary → 4 simple sections
// (Kết quả hiện tại / So với baseline / Độ ổn định / Lịch sử) → collapsed technical.
function rsRenderEvaluation(ev, run, a) {
  const isAdvanced = ev.family === 'SPLINE' || ev.family === 'DECISION_TREE';
  // Insufficient / failed: honest plain-language + exact deficits, no fake zeros.
  if (ev.status !== 'OK') {
    let h = `<div class="fwd-conclusion ${ev.status === 'MODEL_FAILED' ? 'warn' : 'muted'}">`;
    if (ev.status === 'MODEL_FAILED') h += `Mô hình chưa chạy được trên dữ liệu hiện có (${(ev.reasons || []).join(', ') || 'lỗi số học'}). Kết quả được ghi nhận trung thực, không thay bằng số 0.`;
    else h += `Chưa đủ dữ liệu để đánh giá thuật toán này. Hệ thống sẽ tiếp tục đánh giá khi có thêm dữ liệu.`;
    h += `</div>`;
    if (ev.split) {
      const g = ev.guards || {};
      const needR = Math.max(Math.ceil(Math.max(0, (g.MIN_TRAIN || 0) - ev.split.train.n) / 0.6), Math.ceil(Math.max(0, (g.MIN_TEST || 0) - ev.split.test.n) / 0.2));
      if (needR > 0) h += `<div class="muted">Ước tính cần thêm khoảng ${needR} vòng hoàn chỉnh. Hiện có: train ${cnt(ev.split.train.n)} (${cnt(ev.split.train.positives)} dương), test ${cnt(ev.split.test.n)} (${cnt(ev.split.test.positives)} dương).</div>`;
      else h += `<div class="muted">Hiện có: train ${cnt(ev.split.train.n)} (${cnt(ev.split.train.positives)} dương), test ${cnt(ev.split.test.n)} (${cnt(ev.split.test.positives)} dương).</div>`;
    }
    h += rsTechnicalBlock(ev, run);
    return h;
  }
  const t = ev.testMetrics || {}, b = (ev.baseline && ev.baseline.test) || {};
  const pr = rsPlainResult(ev);
  const q = ev.quality || {};
  // Plain-language top summary.
  let summary = '';
  if (isAdvanced) {
    const d = ev.researchDecision || ev.incrementalValue;
    if (d === 'STABLE_INCREMENTAL_VALUE') summary = 'Thuật toán này đang tốt hơn mô hình tuyến tính đơn giản một cách ổn định trong các lần đánh giá gần đây.';
    else if (d === 'UNSTABLE') summary = 'Thuật toán này có vẻ tốt hơn mô hình đơn giản nhưng độ ổn định chưa đủ để kết luận.';
    else if (d === 'NO_INCREMENTAL_VALUE') summary = 'Thuật toán này KHÔNG tốt hơn mô hình tuyến tính đơn giản — độ phức tạp thêm không mang lại giá trị.';
    else summary = 'Chưa đủ bằng chứng để kết luận thuật toán này tốt hơn mô hình đơn giản.';
  } else {
    if (q.status === 'NO_IMPROVEMENT') summary = 'Thuật toán này hiện không tốt hơn mốc cơ bản ngoài mẫu.';
    else if (q.status === 'MATERIAL_STABLE_IMPROVEMENT' || q.status === 'SMALL_STABLE_IMPROVEMENT') summary = 'Thuật toán này đang tốt hơn mốc cơ bản và ổn định trong các lần đánh giá gần đây.';
    else summary = 'Kết quả của thuật toán này chưa ổn định; cần thêm dữ liệu để kết luận.';
  }
  let html = `<div class="fwd-conclusion ${pr.cls}"><b>${pr.icon} ${pr.label}.</b> <span class="muted">${summary}</span></div>`;

  // Section 1 — Kết quả hiện tại (friendly metric first, raw value smaller).
  html += `<div class="section-h">Kết quả hiện tại</div>`;
  html += `<div class="rs-metric"><div class="rs-metric-k">${RS_METRIC_VI.brier}</div><div class="rs-metric-v">${fx(t.brier, 4)}</div><div class="muted">` + (ev.deltaBrierTest > 0 ? `Tốt hơn mốc cơ bản ${fx(ev.deltaBrierTest, 4)}` : `Không tốt hơn mốc cơ bản`) + `</div></div>`;
  html += `<div class="muted">Dựa trên ${cnt(t.n)} vòng kiểm định ngoài mẫu (${cnt(t.positives)} sự kiện dương).</div>`;

  // Section 2 — So với baseline (+ so với mô hình tuyến tính for advanced families).
  html += `<div class="section-h">So với mốc so sánh</div>`;
  html += `<table class="atable"><thead><tr><th></th><th>${RS_METRIC_VI.brier}</th><th>So sánh</th></tr></thead><tbody>`;
  html += `<tr><td>So với mốc cơ bản</td><td>${fx(ev.deltaBrierTest, 4)}</td><td class="${ev.deltaBrierTest > 0 ? 'ms-yes' : ''}">${ev.deltaBrierTest > 0 ? 'Tốt hơn' : 'Không tốt hơn'}</td></tr>`;
  if (isAdvanced && ev.deltaBrierVsLinear != null) html += `<tr><td>So với mô hình tuyến tính</td><td>${fx(ev.deltaBrierVsLinear, 4)}</td><td class="${RS_INCR_CLS[ev.incrementalValue] || ''}">${RS_INCR_VI[ev.incrementalValue] || ev.incrementalValue}</td></tr>`;
  html += `</tbody></table>`;

  // Section 3 — Độ ổn định.
  html += `<div class="section-h">${RS_METRIC_VI.stability}</div>`;
  html += `<div class="${ev.stability && ev.stability.status === 'STABLE' ? 'ms-yes' : 'muted'}">${RS_STABILITY_VI[ev.stability ? ev.stability.status : ''] || '—'}</div>`;

  // Section 4 — Lịch sử đánh giá (link into history tab).
  html += `<div class="section-h">Lịch sử đánh giá</div><div class="muted">Xem tab "Lịch sử" để theo dõi thuật toán này đang tốt lên, xấu đi hay không đổi qua các lần đánh giá.</div>`;

  // Collapsed technical detail (Level 3).
  html += rsTechnicalBlock(ev, run);
  return html;
}

// Level-3 "Chi tiết kỹ thuật" — all raw metrics/fingerprints/ledger, collapsed by default.
function rsTechnicalBlock(ev, run) {
  let t = '';
  t += `<div class="muted">${RS_METRIC_VI.leakage}: ${leakVi(ev.leakageStatus)} (policy v${ev.leakagePolicyVersion}) · Trạng thái: ${RS_STATUS_VI[ev.status] || ev.status}` + (ev.complexity ? ` · Độ phức tạp: ${cnt(ev.complexity.params)} tham số, ${cnt(ev.complexity.features)} biến` : '') + `</div>`;
  t += `<div class="fwd-summary"><b>Dấu vân tay</b> — thuật toán ${rsFp(ev.algorithmFingerprint)} · dữ liệu ${rsFp(ev.datasetFingerprint)}` + (run ? ` · ${run.deduped ? 'đã có (tái dùng)' : 'đã lưu'} #${run.runId}` : '') + `</div>`;
  if (ev.status === 'OK') {
    const tm = ev.testMetrics || {}, b = (ev.baseline && ev.baseline.test) || {};
    t += `<table class="atable"><thead><tr><th>Chỉ số (thô)</th><th>Mô hình</th><th>Baseline</th></tr></thead><tbody>` +
      `<tr><td>ROC AUC</td><td>${fx(tm.auc, 3)}</td><td>—</td></tr>` +
      `<tr><td>PR AUC</td><td>${fx(tm.prAuc, 3)}</td><td>${fx(b.prAuc, 3)}</td></tr>` +
      `<tr><td>Brier</td><td>${fx(tm.brier, 4)}</td><td>${fx(b.brier, 4)}</td></tr>` +
      `<tr><td>Log loss</td><td>${fx(tm.logLoss, 4)}</td><td>${fx(b.logLoss, 4)}</td></tr>` +
      (ev.referenceLinear && ev.referenceLinear.test ? `<tr><td>Brier (tuyến tính tham chiếu)</td><td colspan="2">${fx(ev.referenceLinear.test.brier, 4)}</td></tr>` : '') +
      `</tbody></table>`;
    if (ev.aucCI && ev.aucCI.status === 'OK') t += `<div class="muted">Khoảng tin cậy AUC (bootstrap khối): ${fx(ev.aucCI.low, 3)}–${fx(ev.aucCI.high, 3)}</div>`;
    if (ev.split) t += `<div class="muted">Tách theo thời gian — train ${cnt(ev.split.train.n)} (${cnt(ev.split.train.positives)} dương) · validation ${cnt(ev.split.validation.n)} · test ${cnt(ev.split.test.n)}</div>`;
    t += rsCalibrationBlock(ev.calibration);
    t += rsWalkForwardBlock(ev.walkForward, ev.stability);
    t += rsCoefBlock(ev.coefficientStability);
    t += rsImportanceBlock(ev.modelDiagnostics);
    t += rsLedgerBlock(ev.searchLedger, ev.searchSpaceVersion);
  }
  return `<details class="rs-tech"><summary>Chi tiết kỹ thuật</summary>${t}</details>`;
}

// Descriptive model importance (tree/forest) — labelled MODEL_IMPORTANCE, never cause (§47).
function rsImportanceBlock(diag) {
  if (!diag || !Array.isArray(diag.importance) || !diag.importance.length) return '';
  let html = `<div class="section-h">Mức độ quan trọng của biến (mô tả, không phải nhân quả)</div>`;
  html += `<table class="atable"><thead><tr><th>Biến</th><th>Độ quan trọng (mô hình)</th></tr></thead><tbody>`;
  for (const c of diag.importance) html += `<tr><td>${escapeHtml(c.feature)}</td><td>${fx(c.modelImportance, 3)}</td></tr>`;
  return html + `</tbody></table>`;
}

// Hyperparameter search ledger (§31) — all attempted validation configs, not just the winner.
function rsLedgerBlock(ledger, ssv) {
  if (!Array.isArray(ledger) || !ledger.length) return '';
  let html = `<div class="section-h">Nhật ký tìm siêu tham số (validation) · không gian tìm v${ssv != null ? ssv : '—'}</div>`;
  html += `<table class="atable"><thead><tr><th>Cấu hình</th><th>Brier (validation)</th><th>Trạng thái</th><th>Chọn</th></tr></thead><tbody>`;
  for (const e of ledger) html += `<tr><td class="muted">${escapeHtml(JSON.stringify(e.params || {}))}</td><td>${fx(e.validationBrier, 4)}</td><td>${e.status || '—'}</td><td>${e.selected ? '<b class="ms-yes">✓</b>' : ''}</td></tr>`;
  return html + `</tbody></table>`;
}

function rsCalibrationBlock(cal) {
  const bins = (cal || []).filter((c) => c.n >= 1);
  if (!bins.length) return '';
  let html = `<div class="section-h">Hiệu chỉnh xác suất (calibration)</div>`;
  html += `<table class="atable"><thead><tr><th>Khoảng dự tính</th><th>TB dự tính</th><th>Tỉ lệ quan sát</th><th>n</th><th>Lệch</th></tr></thead><tbody>`;
  for (const c of bins) html += `<tr><td>${pct(c.lo)}–${pct(c.hi)}</td><td>${fx(c.meanPredicted, 3)}</td><td>${fx(c.observedRate, 3)}</td><td class="${nCls(c.n)}">${cnt(c.n)}</td><td>${fx(c.diff, 3)}</td></tr>`;
  html += `</tbody></table><div class="muted">Chỉ hiển thị độ chính xác vừa phải cho ô nhỏ; ô ít mẫu không nên diễn giải quá mức.</div>`;
  return html;
}
function rsWalkForwardBlock(wf, stability) {
  if (!wf || !wf.length) return '';
  let html = `<div class="section-h">Kiểm định trượt theo thời gian (walk-forward) — ${RS_STABILITY_VI[stability ? stability.status : ''] || '—'}</div>`;
  html += `<table class="atable"><thead><tr><th>Fold</th><th>Train n</th><th>Test n</th><th>Tỉ lệ nền</th><th>AUC</th><th>PR AUC</th><th>Brier</th><th>Δ Brier</th></tr></thead><tbody>`;
  for (const f of wf) html += `<tr><td>${f.fold}</td><td>${cnt(f.trainN)}</td><td>${cnt(f.testN)}</td><td>${pct(f.prevalence)}</td><td>${fx(f.auc, 3)}</td><td>${fx(f.prAuc, 3)}</td><td>${fx(f.brier, 4)}</td><td class="${f.deltaBrier > 0 ? 'ms-yes' : ''}">${fx(f.deltaBrier, 4)}</td></tr>`;
  html += `</tbody></table>`;
  return html;
}
function rsCoefBlock(coef) {
  if (!coef || !coef.length) return '';
  let html = `<div class="section-h">Độ ổn định hệ số theo fold</div>`;
  html += `<table class="atable"><thead><tr><th>Biến</th><th>Hệ số TB</th><th>Đổi dấu</th><th>Ổn định</th></tr></thead><tbody>`;
  for (const c of coef) html += `<tr><td>${escapeHtml(c.feature)}</td><td>${fx(c.meanCoef, 3)}</td><td>${c.signFlips ? '<b class="ms-no">Có</b>' : 'Không'}</td><td>${c.stable ? '<b class="ms-yes">Ổn định</b>' : 'Không'}</td></tr>`;
  html += `</tbody></table><div class="muted">Biến đổi dấu hệ số qua các fold được đánh dấu là không ổn định.</div>`;
  return html;
}

// ---- Compare (§50) ----
async function rsRenderCompare() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  const stageOpt = Object.keys(RS_STAGE_VI).map((s) => `<option value="${s}"${rsCompareCell.modelStage === s ? ' selected' : ''}>${RS_STAGE_VI[s]}</option>`).join('');
  const tgtOpt = (rsTargets || []).map((t) => `<option value="${t.targetId}"${rsCompareCell.target === t.targetId ? ' selected' : ''}>${RS_TARGET_VI[t.targetId] || t.targetId}</option>`).join('');
  let html = `<div class="section-h">So sánh thuật toán (cùng mục tiêu · giai đoạn · dữ liệu)</div>`;
  html += `<div class="fwd-controls"><label class="fwd-lab">Giai đoạn <select id="rs-c-stage">${stageOpt}</select></label><label class="fwd-lab">Mục tiêu <select id="rs-c-target">${tgtOpt}</select></label></div>`;
  // Gather latest run per algorithm for this cell.
  const picks = [];
  for (const a of rsAlgos) {
    const hist = await api.research.history({ algorithmId: a.algorithmId, target: rsCompareCell.target, modelStage: rsCompareCell.modelStage, browserScope: rsScope || null });
    if (Array.isArray(hist) && hist.length) picks.push({ algo: a, run: hist[hist.length - 1] });
  }
  if (!picks.length) { html += `<div class="muted">Chưa có lần đánh giá nào đã lưu cho ô này. Hãy đánh giá ở tab "Thuật toán" hoặc "Chạy đánh giá toàn bộ".</div>`; box.innerHTML = html; rsWireCompareControls(); return; }
  html += `<table class="atable"><thead><tr><th>Chọn</th><th>Thuật toán</th><th>Chất lượng</th><th>Test n</th><th>AUC</th><th>Brier</th><th>Δ Brier</th><th>Rò rỉ</th></tr></thead><tbody>`;
  for (const p of picks) html += `<tr><td><input type="checkbox" class="rs-c-pick" value="${p.run.runId}" checked></td><td>${escapeHtml(p.algo.name)}</td><td class="${RS_QUALITY_CLS[p.run.quality] || ''}">${RS_QUALITY_VI[p.run.quality] || p.run.quality || '—'}</td><td>${cnt(p.run.testN)}</td><td>${fx(p.run.auc, 3)}</td><td>${fx(p.run.brier, 4)}</td><td class="${p.run.deltaBrierTest > 0 ? 'ms-yes' : ''}">${fx(p.run.deltaBrierTest, 4)}</td><td>${leakVi(p.run.leakageStatus)}</td></tr>`;
  html += `</tbody></table><button id="rs-c-run" class="mbtn">So sánh các mục đã chọn</button><div id="rs-c-out"></div>`;
  box.innerHTML = html; rsWireCompareControls();
  $('rs-c-run').onclick = async () => {
    const ids = [...document.querySelectorAll('.rs-c-pick:checked')].map((c) => Number(c.value));
    const out = $('rs-c-out'); if (ids.length < 2) { out.innerHTML = '<div class="muted">Chọn ít nhất 2 mục để so sánh.</div>'; return; }
    const r = await api.research.compare({ runIds: ids });
    out.innerHTML = rsRenderComparison(r);
  };
}
function rsWireCompareControls() {
  const ss = $('rs-c-stage'); if (ss) ss.onchange = (e) => { rsCompareCell.modelStage = e.target.value; rsRenderCompare(); };
  const ts = $('rs-c-target'); if (ts) ts.onchange = (e) => { rsCompareCell.target = e.target.value; rsRenderCompare(); };
}
function rsRenderComparison(r) {
  if (r.error) return bailText(r);
  if (!r.comparable) {
    const reasons = (r.reasons || []).join(', ');
    return `<div class="fwd-conclusion warn">Không so sánh trực tiếp được (${r.verdict}${reasons ? ': ' + reasons : ''}). Các kết quả phải cùng mục tiêu, giai đoạn, chính sách và cùng dấu vân tay dữ liệu.</div>`;
  }
  // Plain-language summary first (never "winner"/"best").
  let html = r.summary ? `<div class="fwd-conclusion">${escapeHtml(r.summary)}</div>` : '';
  html += `<div class="section-h">Bảng so sánh (cùng ${RS_TARGET_VI[r.target] || r.target} · ${RS_STAGE_VI[r.modelStage] || r.modelStage})</div>`;
  html += `<table class="atable"><thead><tr><th>Thuật toán</th><th>Loại</th><th>Độ phức tạp</th><th>Sai số xác suất</th><th>So mốc cơ bản</th><th>So tuyến tính</th><th>Ổn định</th><th>Kết quả</th></tr></thead><tbody>`;
  for (const x of r.rows) html += `<tr><td>${escapeHtml(x.algorithmName || x.algorithmId)} <span class="muted">v${x.version}</span></td><td>${RS_FAMILY_VI[x.family] || x.family}</td><td class="muted">${cnt(x.complexityParams)} tham số</td><td>${fx(x.brier, 4)}</td><td class="${x.deltaBrierTest > 0 ? 'ms-yes' : ''}">${fx(x.deltaBrierTest, 4)}</td><td class="${RS_INCR_CLS[x.incrementalValue] || ''}">${x.deltaBrierVsLinear != null ? fx(x.deltaBrierVsLinear, 4) : '—'}</td><td>${RS_STABILITY_VI[x.stabilityStatus] || '—'}</td><td class="${RS_QUALITY_CLS[x.quality] || ''}">${RS_QUALITY_VI[x.quality] || x.quality || '—'}</td></tr>`;
  html += `</tbody></table><div class="muted">Sắp xếp theo sai số xác suất chỉ để trình bày — KHÔNG phải xếp hạng "thắng/thua". Kết quả là đánh giá đa tiêu chí theo từng thuật toán.</div>`;
  return html;
}

// ---- History / Trend (§46) + drift (§51) ----
async function rsRenderHistory() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  box.innerHTML = rsCellControls('h') + `<div id="rs-h-out"></div>`;
  rsWireCellControls('h', rsRenderHistory);
  const out = $('rs-h-out');
  const hist = await api.research.history({ algorithmId: rsSel.algorithmId, target: rsSel.target, modelStage: rsSel.modelStage, browserScope: rsScope || null });
  const drift = await api.research.drift({ algorithmId: rsSel.algorithmId, target: rsSel.target, modelStage: rsSel.modelStage, browserScope: rsScope || null });
  let html = '';
  if (!Array.isArray(hist) || !hist.length) { out.innerHTML = `<div class="muted">Chưa có lần đánh giá nào đã lưu cho ô này.</div>`; return; }
  html += `<div class="section-h">Lịch sử đánh giá (cũ → mới) — thuật toán này đang tốt lên, xấu đi hay không đổi?</div>`;
  html += `<table class="atable"><thead><tr><th>Thời điểm</th><th>Thế hệ</th><th>Số vòng</th><th>Tỉ lệ nền</th><th>Sai số xác suất</th><th>So mốc cơ bản</th><th>Ổn định</th><th>Kết quả</th></tr></thead><tbody>`;
  for (const r of hist) html += `<tr><td>${rsTime(r.evaluatedAtMs)}</td><td class="muted">#${cnt(r.evaluationGeneration)}</td><td>${cnt(r.testN)}</td><td>${pct(r.prevalence)}</td><td>${fx(r.brier, 4)}</td><td class="${r.deltaBrierTest > 0 ? 'ms-yes' : ''}">${fx(r.deltaBrierTest, 4)}</td><td>${RS_STABILITY_VI[r.stabilityStatus] || '—'}</td><td class="${RS_QUALITY_CLS[r.quality] || ''}">${RS_QUALITY_VI[r.quality] || r.quality || '—'}</td></tr>`;
  html += `</tbody></table>`;
  html += rsDriftBlock(drift);
  out.innerHTML = html;
}
function rsDriftBlock(d) {
  if (!d || d.error) return '';
  let html = `<div class="section-h">Biến động hiệu năng so với lần trước</div>`;
  if (d.previousEvaluation === 'NONE') return html + `<div class="muted">Chưa có lần đánh giá trước để so sánh (PREVIOUS_EVALUATION = NONE).</div>`;
  html += `<div class="fwd-conclusion ${RS_DRIFT_CLS[d.status] || ''}">Trạng thái: <b>${RS_DRIFT_VI[d.status] || d.status}</b></div>`;
  if (d.deltas) html += kv([['Δ Brier', fx(d.deltas.brier, 4)], ['Δ AUC', fx(d.deltas.auc, 3)], ['Δ Tỉ lệ nền', fx(d.deltas.prevalence, 4)], ['Δ Test n', cnt(d.deltas.testN)]]);
  if (d.baseRate) html += `<div class="muted">Tỉ lệ nền: trước ${pct(d.baseRate.previous)} → nay ${pct(d.baseRate.current)} (Δ ${fx(d.baseRate.delta, 4)})${d.baseRate.materialShift ? ' — thay đổi đáng kể' : ''}.</div>`;
  return html;
}

// ---- Stability (§47) ----
async function rsRenderStability() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  box.innerHTML = rsCellControls('s') + `<div id="rs-s-out"></div>`;
  rsWireCellControls('s', rsRenderStability);
  const out = $('rs-s-out');
  const hist = await api.research.history({ algorithmId: rsSel.algorithmId, target: rsSel.target, modelStage: rsSel.modelStage, browserScope: rsScope || null });
  if (!Array.isArray(hist) || !hist.length) { out.innerHTML = `<div class="muted">Chưa có lần đánh giá nào đã lưu cho ô này.</div>`; return; }
  const full = await api.research.run(hist[hist.length - 1].runId);
  if (!full || full.error) { out.innerHTML = bailText(full || {}); return; }
  const ev = JSON.parse(full.resultJson);
  let html = `<div class="muted">Lần đánh giá gần nhất: ${rsTime(full.evaluatedAtMs)} · dữ liệu ${rsFp(full.datasetFingerprint)}</div>`;
  html += rsWalkForwardBlock(ev.walkForward, ev.stability);
  html += rsCoefBlock(ev.coefficientStability);
  if (!ev.walkForward || !ev.walkForward.length) html += `<div class="muted">Không đủ dữ liệu cho walk-forward.</div>`;
  out.innerHTML = html;
}

// ---- Readiness (§49) ----
async function rsRenderReadiness() {
  const box = $('rs-panel'); box.innerHTML = '<div class="muted">Đang tải…</div>';
  const m = await api.research.readinessMatrix({ browserScope: rsScope || null });
  if (m.error) { box.innerHTML = bailText(m); return; }
  let html = `<div class="section-h">Chất lượng dữ liệu theo thuật toán × giai đoạn × mục tiêu</div>`;
  html += `<table class="atable"><thead><tr><th>Thuật toán</th><th>Giai đoạn</th><th>Mục tiêu</th><th>Trạng thái</th><th>Train n</th><th>Test n</th><th>Dương (train/test)</th><th>Thiếu</th></tr></thead><tbody>`;
  for (const c of m.cells) {
    const r = c.readiness; const ok = r.status === 'READY';
    const deficits = [];
    if (r.trainDeficit) deficits.push(`train −${cnt(r.trainDeficit)}`);
    if (r.testDeficit) deficits.push(`test −${cnt(r.testDeficit)}`);
    if (r.positiveDeficit) deficits.push(`dương −${cnt(r.positiveDeficit)}`);
    html += `<tr><td>${escapeHtml(c.algorithmId)}</td><td>${RS_STAGE_VI[c.modelStage] || c.modelStage}</td><td>${RS_TARGET_VI[c.target] || c.target}</td>` +
      `<td class="${ok ? 'ms-yes' : 'ms-no'}">${RS_READY_VI[r.status] || r.status}</td><td>${cnt(r.train ? r.train.n : null)}</td><td>${cnt(r.test ? r.test.n : null)}</td>` +
      `<td>${cnt(r.train ? r.train.positives : null)} / ${cnt(r.test ? r.test.positives : null)}</td><td class="muted">${deficits.join(', ') || '—'}</td></tr>`;
  }
  html += `</tbody></table><div class="muted">Không đánh giá nào được coi là hợp lệ khi chưa đạt ngưỡng mẫu tối thiểu (train ${m.cells[0] ? cnt(m.cells[0].readiness.guards.MIN_TRAIN) : ''}, test ${m.cells[0] ? cnt(m.cells[0].readiness.guards.MIN_TEST) : ''}, dương mỗi tập ${m.cells[0] ? cnt(m.cells[0].readiness.guards.MIN_POS_PER_SET) : ''}).</div>`;
  box.innerHTML = html;
}

// Shared algorithm/stage/target selector for History + Stability.
function rsCellControls(pfx) {
  const aOpt = rsAlgos.map((a) => `<option value="${a.algorithmId}"${rsSel.algorithmId === a.algorithmId ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  const sOpt = Object.keys(RS_STAGE_VI).map((s) => `<option value="${s}"${rsSel.modelStage === s ? ' selected' : ''}>${RS_STAGE_VI[s]}</option>`).join('');
  const tOpt = (rsTargets || []).map((t) => `<option value="${t.targetId}"${rsSel.target === t.targetId ? ' selected' : ''}>${RS_TARGET_VI[t.targetId] || t.targetId}</option>`).join('');
  return `<div class="fwd-controls"><label class="fwd-lab">Thuật toán <select id="rs-${pfx}-algo">${aOpt}</select></label>` +
    `<label class="fwd-lab">Giai đoạn <select id="rs-${pfx}-stage">${sOpt}</select></label>` +
    `<label class="fwd-lab">Mục tiêu <select id="rs-${pfx}-target">${tOpt}</select></label></div>`;
}
function rsWireCellControls(pfx, rerender) {
  $(`rs-${pfx}-algo`).onchange = (e) => { rsSel.algorithmId = e.target.value; rerender(); };
  $(`rs-${pfx}-stage`).onchange = (e) => { rsSel.modelStage = e.target.value; rerender(); };
  $(`rs-${pfx}-target`).onchange = (e) => { rsSel.target = e.target.value; rerender(); };
}

// ---------- boot ----------
populateJpRanges();
refreshBrowsers().then(() => refreshHome());
