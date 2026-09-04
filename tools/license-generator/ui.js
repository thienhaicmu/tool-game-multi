(function () {
  const api = window.licenseGenerator;
  const $ = (id) => document.getElementById(id);
  const UTC_PLUS_7 = 7 * 60 * 60;
  const FEATURE_LABELS = { autoRun: 'Chạy tự động', jackpotLive: 'Jackpot trực tiếp', jackpotGate: 'Chờ Jackpot', roundHistory: 'Lịch sử vòng chơi' };
  let presets = null;

  const ymd = (s) => new Date((Number(s) + UTC_PLUS_7) * 1000).toISOString().slice(0, 10);

  // ---- private key status ----
  async function refreshKey() {
    const status = await api.keyStatus();
    $('key-path').textContent = status.envKey ? 'Nạp từ biến môi trường WVPT_PRIVATE_KEY' : status.privateKeyPath;
    const ready = status.envKey || status.exists;
    $('key-chip').textContent = ready ? 'ĐÃ NẠP KHÓA KÝ' : 'CHƯA CÓ KHÓA KÝ';
    $('key-chip').className = 'chip ' + (ready ? 'on' : 'off');
  }

  // ---- create tab ----
  function features() {
    return {
      autoRun: $('f-auto-run').checked,
      jackpotLive: $('f-jackpot-live').checked,
      jackpotGate: $('f-jackpot-gate').checked,
      roundHistory: $('f-round-history').checked,
    };
  }
  // Dependency (§10): "Chờ Jackpot" needs "Jackpot trực tiếp".
  function applyDependency() {
    const live = $('f-jackpot-live').checked;
    const gate = $('f-jackpot-gate');
    gate.disabled = !live;
    if (!live) gate.checked = false;
    $('feature-note').textContent = live ? '' : '“Chờ Jackpot” cần bật “Jackpot trực tiếp”.';
  }
  function applyPreset() {
    if (!presets) return;
    const p = presets[$('plan').value];
    if (!p) return;
    $('max-browsers').value = p.maxBrowsers;
    $('max-concurrent').value = p.maxConcurrentBrowsers;
    $('f-auto-run').checked = !!p.features.autoRun;
    $('f-jackpot-live').checked = !!p.features.jackpotLive;
    $('f-jackpot-gate').checked = !!p.features.jackpotGate;
    $('f-round-history').checked = !!p.features.roundHistory;
    applyDependency();
  }
  function syncCustom() { $('custom-wrap').hidden = $('duration').value !== 'custom'; }

  async function generate() {
    $('error').hidden = true; $('generate-ok').hidden = true;
    $('generate').disabled = true;
    const result = await api.generateLicense({
      machineId: $('machine-id').value,
      schema: 2,
      plan: $('plan').value,
      mode: $('duration').value === 'custom' ? 'custom' : 'duration',
      durationDays: Number($('duration').value),
      expires: $('custom-expiry').value,
      maxBrowsers: Number($('max-browsers').value),
      maxConcurrentBrowsers: Number($('max-concurrent').value),
      features: features(),
    });
    $('generate').disabled = false;
    if (!result.ok) { $('error').hidden = false; $('error').textContent = result.error.message || result.error.code; return; }
    const p = result.payload;
    $('license-output').value = result.license;
    $('generate-ok').hidden = false;
    $('license-id').textContent = p.licenseId;
    $('license-plan').textContent = p.plan || '—';
    $('license-maxbrowsers').textContent = p.maxBrowsers != null ? p.maxBrowsers : '—';
    $('license-maxconcurrent').textContent = p.maxConcurrentBrowsers != null ? p.maxConcurrentBrowsers : '—';
    $('expires').textContent = ymd(p.expiresAt);
    $('copy-license').disabled = false;
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
    $('i-expires').textContent = p.expiresAt ? ymd(p.expiresAt) : '—';
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
  $('choose-key').onclick = async () => { await api.choosePrivateKey(); refreshKey(); };
  $('plan').onchange = applyPreset;
  $('duration').onchange = syncCustom;
  $('f-jackpot-live').onchange = applyDependency;
  $('generate').onclick = generate;
  $('copy-license').onclick = () => api.copy($('license-output').value);
  $('inspect').onclick = inspect;
  $('tab-create').onclick = () => showTab('create');
  $('tab-inspect').onclick = () => showTab('inspect');

  (async () => {
    try { presets = await api.planPresets(); } catch { presets = null; }
    applyPreset();
    syncCustom();
    refreshKey();
  })();
})();
