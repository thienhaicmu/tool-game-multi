(function () {
  const api = window.licenseGenerator;
  const $ = (id) => document.getElementById(id);
  const FEATURE_LABELS = { autoRun: 'Chạy tự động', jackpotLive: 'Jackpot trực tiếp', jackpotGate: 'Chờ Jackpot', roundHistory: 'Lịch sử vòng chơi' };
  let presets = null;      // desktop entitlements PLAN_PRESETS (features authority)
  let planDefaults = null; // generator UI defaults (duration + capacity + features)

  // The last successfully generated record, kept for Copy + retry-sync. Retry MUST
  // reuse this exact record (same licenseId / issuedAt / expiresAt / signature).
  let lastRecord = null;

  // ---- signing readiness (auto-resolved bundled key; no selector) ----
  async function refreshSigning() {
    let s; try { s = await api.signingStatus(); } catch { s = null; }
    const ready = !!(s && s.ready);
    setChip($('signing-chip'), ready ? 'on' : 'err', ready ? 'Sẵn sàng' : 'Chưa sẵn sàng');
  }

  // ---- selection state ----
  function selectedPlan() {
    const el = document.querySelector('.plan-card.selected');
    return el ? el.dataset.plan : 'STANDARD';
  }
  function selectedDurationSpec() {
    const el = document.querySelector('.dur-chip.selected');
    if (!el) return { unit: 'months', value: 1 };
    if (el.dataset.unit === 'custom') return { unit: 'custom', expires: $('custom-expiry').value };
    if (el.dataset.unit === 'days') return { unit: 'days', value: Number(el.dataset.value) };
    return { unit: 'months', value: Number(el.dataset.value) };
  }
  function selectDurationEl(el) {
    document.querySelectorAll('.dur-chip').forEach((c) => c.classList.toggle('selected', c === el));
    $('custom-wrap').hidden = el.dataset.unit !== 'custom';
    updatePreview();
  }
  function selectDurationBySpec(spec) {
    const match = Array.from(document.querySelectorAll('.dur-chip')).find((c) => {
      if (spec.unit === 'days') return c.dataset.unit === 'days' && Number(c.dataset.value) === Number(spec.value);
      if (spec.unit === 'months') return c.dataset.unit === 'months' && Number(c.dataset.value) === Number(spec.value);
      return false;
    });
    if (match) selectDurationEl(match);
  }

  // ---- features ----
  function features() {
    return {
      autoRun: $('f-auto-run').checked,
      jackpotLive: $('f-jackpot-live').checked,
      jackpotGate: $('f-jackpot-gate').checked,
      roundHistory: $('f-round-history').checked,
    };
  }
  function applyDependency() {
    const live = $('f-jackpot-live').checked;
    const gate = $('f-jackpot-gate');
    gate.disabled = !live;
    if (!live) gate.checked = false;
    $('feature-note').textContent = live ? '' : '“Chờ Jackpot” cần bật “Jackpot trực tiếp”.';
  }

  // ---- plan -> defaults (duration + capacity + features) ----
  function applyPlan(plan) {
    document.querySelectorAll('.plan-card').forEach((c) => c.classList.toggle('selected', c.dataset.plan === plan));
    const d = planDefaults && planDefaults[plan];
    if (!d) return;
    $('max-browsers').value = d.maxBrowsers;
    $('max-concurrent').value = d.maxConcurrentBrowsers;
    const f = d.features || {};
    $('f-auto-run').checked = !!f.autoRun;
    $('f-jackpot-live').checked = !!f.jackpotLive;
    $('f-jackpot-gate').checked = !!f.jackpotGate;
    $('f-round-history').checked = !!f.roundHistory;
    applyDependency();
    if (d.duration) selectDurationBySpec(d.duration);
    else updatePreview();
  }

  // ---- expiry preview ----
  let previewSeq = 0;
  async function updatePreview() {
    const seq = ++previewSeq;
    const spec = selectedDurationSpec();
    if (spec.unit === 'custom' && !spec.expires) {
      $('preview-issued').textContent = '—'; $('preview-expires').textContent = '—'; $('preview-note').textContent = '';
      return;
    }
    let res;
    try { res = await api.previewExpiry({ duration: spec }); } catch { res = null; }
    if (seq !== previewSeq) return; // a newer request superseded this one
    if (!res || !res.ok) {
      $('preview-issued').textContent = '—';
      $('preview-expires').textContent = '—';
      $('preview-note').textContent = res && res.error ? res.error.message : '';
      return;
    }
    $('preview-issued').textContent = res.issuedText;
    $('preview-expires').textContent = res.expiresText;
    $('preview-note').textContent = res.estimated ? 'Xem trước theo giờ máy (giá trị ký chính thức dùng giờ tin cậy khi tạo khóa).' : '';
  }

  // ---- google sheet status ----
  function setChip(el, cls, text) { el.className = 'dot-chip ' + cls; el.textContent = text; }
  async function refreshSheetStatus() {
    setChip($('sheet-chip'), '', 'Đang kiểm tra…');
    let s; try { s = await api.sheetStatus(); } catch { s = null; }
    if (!s || !s.configured) { setChip($('sheet-chip'), 'off', 'Không kết nối được'); return; }
    if (s.state === 'connected') { setChip($('sheet-chip'), 'on', 'Đã kết nối'); return; }
    setChip($('sheet-chip'), 'err', 'Không kết nối được');
  }

  // ---- generate ----
  let generating = false;
  async function generate() {
    if (generating) return; // re-entrancy guard: double-click cannot double-sign
    generating = true;
    $('error').hidden = true; $('generate-ok').hidden = true; $('sync-warn').hidden = true;
    $('generate').disabled = true;
    let result;
    try {
      result = await api.generateLicense({
        machineId: $('machine-id').value,
        schema: 2,
        plan: selectedPlan(),
        duration: selectedDurationSpec(),
        maxBrowsers: Number($('max-browsers').value),
        maxConcurrentBrowsers: Number($('max-concurrent').value),
        features: features(),
        customerName: $('customer-name').value.trim(),
        phone: $('customer-phone').value.trim(),
        note: $('note').value.trim(),
      });
    } finally {
      $('generate').disabled = false;
      generating = false;
    }
    if (!result || !result.ok) {
      $('error').hidden = false;
      $('error').textContent = (result && result.error && (result.error.message || result.error.code)) || 'Tạo khóa thất bại.';
      return;
    }
    const p = result.payload;
    lastRecord = { payload: p, license: result.license, metadata: result.metadata };
    $('license-output').value = result.license;
    $('license-id').textContent = p.licenseId;
    $('license-plan').textContent = p.plan || '—';
    $('license-maxbrowsers').textContent = p.maxBrowsers != null ? p.maxBrowsers : '—';
    $('license-maxconcurrent').textContent = p.maxConcurrentBrowsers != null ? p.maxConcurrentBrowsers : '—';
    $('expires').textContent = fmt(p.expiresAt);
    $('copy-license').disabled = false;
    renderSyncOutcome(result.sheet);
  }

  function renderSyncOutcome(sheet) {
    if (sheet && sheet.synced) {
      $('generate-ok').hidden = false;
      $('generate-ok').textContent = 'Đã tạo key và lưu Google Sheet.';
      $('sync-warn').hidden = true;
    } else {
      $('generate-ok').hidden = false;
      $('generate-ok').textContent = 'Key đã tạo thành công.';
      $('sync-warn').hidden = false;
      const reason = sheet && sheet.error ? ` (${sheet.error.message})` : '';
      $('sync-warn-text').textContent = 'Chưa lưu được Google Sheet.' + reason;
    }
  }

  async function retrySync() {
    if (!lastRecord) return;
    $('retry-sync').disabled = true;
    $('sync-warn-text').textContent = 'Đang đồng bộ lại…';
    let res; try { res = await api.syncLicense(lastRecord); } catch { res = null; }
    $('retry-sync').disabled = false;
    if (res && res.synced) { $('generate-ok').textContent = 'Đã tạo key và lưu Google Sheet.'; $('sync-warn').hidden = true; }
    else { $('sync-warn-text').textContent = 'Chưa lưu được Google Sheet.' + (res && res.error ? ` (${res.error.message})` : ''); }
    refreshSheetStatus();
  }

  const UTC_PLUS_7 = 7 * 60 * 60;
  function fmt(s) {
    if (!Number.isFinite(Number(s))) return '—';
    const d = new Date((Number(s) + UTC_PLUS_7) * 1000);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  }

  // ---- inspect tab ----
  async function inspect() {
    $('inspect-error').hidden = true; $('inspect-body').hidden = true;
    const res = await api.inspectLicense($('inspect-input').value.trim());
    if (!res || !res.ok) { $('inspect-error').hidden = false; $('inspect-error').textContent = (res && res.error) || 'Không đọc được khóa.'; $('inspect-sig').textContent = '—'; $('inspect-sig').className = 'chip off'; return; }
    $('inspect-sig').textContent = res.signatureValid ? 'CHỮ KÝ HỢP LỆ' : 'CHỮ KÝ KHÔNG HỢP LỆ';
    $('inspect-sig').className = 'chip ' + (res.signatureValid ? 'on' : 'off');
    const ent = res.entitlement || {};
    const p = res.payload || {};
    $('inspect-body').hidden = false;
    $('i-license-id').textContent = p.licenseId || '—';
    $('i-machine').textContent = p.machineId || '—';
    $('i-plan').textContent = ent.plan || (p.v === 1 ? 'LEGACY' : '—');
    $('i-expires').textContent = p.expiresAt ? fmt(p.expiresAt) : '—';
    $('i-maxbrowsers').textContent = ent.maxBrowsers == null ? 'Không giới hạn' : ent.maxBrowsers;
    $('i-maxconcurrent').textContent = ent.maxConcurrentBrowsers == null ? 'Không giới hạn' : ent.maxConcurrentBrowsers;
    const f = ent.features || {};
    $('i-features').innerHTML = Object.keys(FEATURE_LABELS).map((k) =>
      `<div class="feat ${f[k] ? 'on' : 'off'}">${f[k] ? '✓' : '✕'} ${FEATURE_LABELS[k]}</div>`).join('');
  }

  // ---- tabs ----
  function showTab(which) {
    $('view-create').hidden = which !== 'create';
    $('view-inspect').hidden = which !== 'inspect';
    $('tab-create').classList.toggle('active', which === 'create');
    $('tab-inspect').classList.toggle('active', which === 'inspect');
  }

  // ---- wire ----
  document.querySelectorAll('.plan-card').forEach((c) => { c.onclick = () => applyPlan(c.dataset.plan); });
  document.querySelectorAll('.dur-chip').forEach((c) => { c.onclick = () => selectDurationEl(c); });
  $('custom-expiry').onchange = updatePreview;
  $('f-jackpot-live').onchange = applyDependency;
  $('generate').onclick = generate;
  $('retry-sync').onclick = retrySync;
  $('copy-license').onclick = () => api.copy($('license-output').value);
  $('inspect').onclick = inspect;
  $('tab-create').onclick = () => showTab('create');
  $('tab-inspect').onclick = () => showTab('inspect');

  (async () => {
    try { presets = await api.planPresets(); } catch { presets = null; }
    try { planDefaults = await api.planDefaults(); } catch { planDefaults = null; }
    applyPlan(selectedPlan());
    refreshSigning();
    refreshSheetStatus();
  })();
})();
