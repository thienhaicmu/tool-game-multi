(function () {
  const api = window.licenseGenerator;
  const $ = (id) => document.getElementById(id);
  const DAY = 86400;
  const UTC_PLUS_7 = 7 * 3600;

  let configs = null;   // { order, games } from main (game-configs.cjs)
  let game = null;      // selected game config
  let lastRecord = null; // exact generated record — reused for retry-sync (same licenseId)

  function fmtDate(s) {
    if (!Number.isFinite(Number(s))) return '—';
    const d = new Date((Number(s) + UTC_PLUS_7) * 1000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  }
  function option(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
  function fillSelect(sel, items, selected) {
    sel.replaceChildren(...items.map((it) => option(it.value, it.label)));
    if (selected != null && items.some((it) => it.value === selected)) sel.value = selected;
  }

  // ---- game-scoped form ----
  function durationSpec() {
    const d = game.durations.find((x) => x.id === $('duration').value) || game.durations[0];
    if (d.unit === 'custom') return { unit: 'custom', expires: $('custom-expiry').value };
    return { unit: d.unit, value: d.value };
  }
  function currentPlan() { return game.plans.find((p) => p.id === $('plan').value) || game.plans[0]; }

  // Switching game REBUILDS every game-specific control from that game's config. Only
  // common values (machine id, customer info, a duration both games offer) are kept.
  function selectGame(id) {
    const keepDuration = $('duration').value;
    game = configs.games[id];
    $('game').value = game.game;
    $('game-title').textContent = `${game.label} LICENSE`;
    fillSelect($('plan'), game.plans.map((p) => ({ value: p.id, label: p.label })), game.defaultPlan);
    fillSelect($('duration'), game.durations.map((d) => ({ value: d.id, label: d.label })), null);
    $('capacities').replaceChildren(...game.capacities.map((c) => {
      const wrap = document.createElement('label'); wrap.className = 'field';
      wrap.innerHTML = `<span class="lbl"></span><input class="mono" type="number" step="1">`;
      wrap.firstChild.textContent = c.label;
      const input = wrap.querySelector('input'); input.id = `cap-${c.key}`; input.min = c.min; input.max = c.max;
      return wrap;
    }));
    $('features').replaceChildren(...game.features.map((f) => {
      const wrap = document.createElement('label');
      const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.feature = f.key; box.onchange = applyDependencies;
      wrap.append(box, document.createTextNode(f.label));
      return wrap;
    }));
    $('features-wrap').hidden = game.features.length === 0;
    applyPlan(keepDuration);
    refreshProductInfo();
  }

  // Plan -> this game's defaults (capacities, features, duration). A duration the user had
  // picked is kept only if this game offers it.
  function applyPlan(keepDuration) {
    const plan = currentPlan();
    for (const c of game.capacities) $(`cap-${c.key}`).value = plan.capacities[c.key];
    document.querySelectorAll('#features input[data-feature]').forEach((box) => { box.checked = plan.features[box.dataset.feature] === true; });
    const durationIds = game.durations.map((d) => d.id);
    $('duration').value = keepDuration && durationIds.includes(keepDuration) ? keepDuration : plan.defaultDuration;
    applyDependencies();
    onDurationChange();
  }

  function applyDependencies() {
    const notes = [];
    for (const f of game.features) {
      if (!f.requires) continue;
      const box = document.querySelector(`#features input[data-feature="${f.key}"]`);
      const dep = document.querySelector(`#features input[data-feature="${f.requires}"]`);
      box.disabled = !dep.checked;
      if (!dep.checked) { box.checked = false; notes.push(`“${f.label}” cần bật “${game.features.find((x) => x.key === f.requires).label}”.`); }
    }
    $('feature-note').textContent = notes.join(' ');
  }

  function features() {
    const out = {};
    document.querySelectorAll('#features input[data-feature]').forEach((box) => { out[box.dataset.feature] = box.checked; });
    return out;
  }

  function onDurationChange() {
    $('custom-wrap').hidden = durationSpec().unit !== 'custom';
    updatePreview();
  }

  let previewSeq = 0;
  async function updatePreview() {
    const seq = ++previewSeq;
    const spec = durationSpec();
    if (spec.unit === 'custom' && !spec.expires) { $('preview-expires').textContent = '—'; $('preview-note').textContent = ''; return; }
    let res; try { res = await api.previewExpiry({ duration: spec }); } catch { res = null; }
    if (seq !== previewSeq) return;
    $('preview-expires').textContent = res && res.ok ? res.expiresText : '—';
    $('preview-note').textContent = res && res.ok ? (res.estimated ? 'ước tính theo giờ máy' : '') : (res && res.error ? res.error.message : '');
  }

  async function refreshProductInfo() {
    const gp = game.game;
    let info; try { info = await api.productInfo(gp); } catch { info = null; }
    if (!game || game.game !== gp) return;
    const meta = $('game-meta');
    if (info && info.ok) {
      meta.textContent = `Khóa ${info.signingKeyId} · Sheet ${info.targetSheet || '—'}` + (info.signingReady ? '' : ` · thiếu private key (${info.signingCode})`);
      meta.className = 'meta' + (info.signingReady ? '' : ' bad');
      $('generate').disabled = !info.signingReady;
    } else { meta.textContent = ''; }
  }

  // ---- generate ----
  let generating = false;
  async function generate() {
    if (generating) return; // double-click cannot double-sign
    generating = true;
    $('generate').disabled = true;
    let result;
    try {
      const caps = {};
      for (const c of game.capacities) caps[c.key] = Number($(`cap-${c.key}`).value);
      result = await api.generateLicense({
        game: game.game,
        plan: currentPlan().id,
        duration: durationSpec(),
        machineId: $('machine-id').value,
        ...caps,
        features: features(),
        customerName: $('customer-name').value.trim(),
        phone: $('customer-phone').value.trim(),
        note: $('note').value.trim(),
      });
    } catch (e) {
      result = { ok: false, error: { code: 'IPC_FAILED', message: 'Không gọi được tiến trình ký.' } };
    } finally {
      generating = false;
      refreshProductInfo();
    }
    $('result-empty').hidden = true;
    if (!result || !result.ok) {
      $('result').hidden = true;
      $('error').hidden = false;
      const err = (result && result.error) || {};
      $('error-reason').textContent = err.message || err.code || 'Lỗi không xác định';
      $('error-detail').textContent = [err.code, err.detail].filter(Boolean).join(' · ');
      return;
    }
    $('error').hidden = true;
    renderResult(result);
  }

  function renderResult(result) {
    const p = result.payload;
    const cfg = configs.games[p.gameProduct];
    lastRecord = { payload: p, license: result.license, metadata: result.metadata };
    $('r-game').textContent = cfg ? cfg.label : p.gameProduct;
    $('r-plan').textContent = (cfg && (cfg.plans.find((x) => x.id === p.plan) || {}).label) || p.plan;
    $('r-machine').textContent = p.machineId;
    $('r-expires').textContent = fmtDate(p.expiresAt);
    $('r-remaining').textContent = `${Math.ceil((p.expiresAt - p.issuedAt) / DAY)} ngày`;
    $('r-caps').textContent = `${p.maxBrowsers} profiles · ${p.maxConcurrentBrowsers} browsers`;
    $('r-license-id').textContent = p.licenseId;
    $('license-output').value = result.license;
    $('copy-ok').hidden = true;
    $('result').hidden = false;
    renderSheet(result.sheet);
  }

  function renderSheet(sheet) {
    const line = $('sheet-line');
    if (sheet && sheet.synced) {
      line.textContent = `✓ Đã lưu Sheet ${sheet.sheetTitle || ''}`.trim();
      line.className = 'sheet-line ok';
      $('retry-sync').hidden = true;
    } else {
      line.textContent = 'Chưa lưu Sheet' + (sheet && sheet.error ? ` — ${sheet.error.message}` : '') + ' (license vẫn dùng được)';
      line.className = 'sheet-line warn';
      $('retry-sync').hidden = false;
    }
  }

  async function retrySync() {
    if (!lastRecord) return;
    $('retry-sync').disabled = true;
    let res; try { res = await api.syncLicense(lastRecord); } catch { res = null; }
    $('retry-sync').disabled = false;
    renderSheet(res);
    refreshSheetStatus();
  }

  async function copyKey() {
    if (!lastRecord) return;
    await api.copy(lastRecord.license);
    $('copy-ok').hidden = false;
  }

  // ---- header status ----
  async function refreshSheetStatus() {
    const chip = $('sheet-chip');
    let s; try { s = await api.sheetStatus(); } catch { s = null; }
    const set = (cls, text) => { chip.className = `chip ${cls}`; chip.innerHTML = '<i class="dot"></i>'; chip.append(text); };
    if (!s || !s.configured) set('warn', 'Sheet Off');
    else if (s.state === 'connected') set('ok', 'Sheet Ready');
    else set('bad', 'Sheet Error');
    // Actionable tooltip: on error show the message; when unconfigured show WHERE to drop the credential file.
    if (s && s.error) chip.title = s.error.message || s.error.code;
    else if (s && !s.configured && s.expectedPath) chip.title = `Chưa có Google Service Account. Đặt tệp google-service-account.json tại:\n${s.expectedPath}`;
    else chip.removeAttribute('title');
  }
  async function refreshSigning() {
    let s; try { s = await api.signingStatus(); } catch { s = null; }
    const chip = $('signing-chip');
    if (!s || !s.games) { chip.className = 'chip bad'; chip.textContent = 'Ký: lỗi'; return; }
    chip.textContent = 'Ký: ' + configs.order.map((g) => `${configs.games[g].label} ${s.games[g] && s.games[g].ready ? '✓' : '✕'}`).join(' · ');
    chip.className = 'chip ' + (s.ready ? 'ok' : 'bad');
  }

  // ---- diagnostics ----
  async function inspect() {
    const res = await api.diagnoseLicense({ license: $('inspect-input').value, game: $('inspect-game').value, machineId: $('inspect-machine').value });
    $('inspect-empty').hidden = true;
    $('inspect-body').hidden = false;
    const head = $('inspect-head');
    const target = configs.games[res.expectedGame] ? configs.games[res.expectedGame].label : $('inspect-game').value;
    head.textContent = res.ok ? `✓ VALID trong ${target}` : `✕ INVALID trong ${target}${res.code ? ` — ${res.code}` : ''}`;
    head.className = 'slip-head' + (res.ok ? '' : ' bad');
    $('inspect-steps').replaceChildren(...(res.steps || []).flatMap((st) => {
      const dt = document.createElement('dt'); dt.textContent = st.label;
      const dd = document.createElement('dd'); dd.textContent = st.detail; dd.className = st.ok === true ? 'ok' : st.ok === false ? 'no' : 'skip';
      return [dt, dd];
    }));
    $('inspect-note').textContent = res.estimatedTime ? 'Hạn dùng tính theo giờ máy (chưa có giờ tin cậy).' : '';
  }

  function showTab(which) {
    $('view-create').hidden = which !== 'create';
    $('view-inspect').hidden = which !== 'inspect';
    $('tab-create').classList.toggle('active', which === 'create');
    $('tab-inspect').classList.toggle('active', which === 'inspect');
    if (which === 'inspect' && game) $('inspect-game').value = game.game;
  }

  // ---- wire ----
  $('game').onchange = () => selectGame($('game').value);
  $('plan').onchange = () => applyPlan(null);
  $('duration').onchange = onDurationChange;
  $('custom-expiry').onchange = updatePreview;
  $('generate').onclick = generate;
  $('retry-sync').onclick = retrySync;
  $('copy-license').onclick = copyKey;
  $('inspect').onclick = inspect;
  $('tab-create').onclick = () => showTab('create');
  $('tab-inspect').onclick = () => showTab('inspect');

  (async () => {
    configs = await api.gameConfigs();
    const games = configs.order.map((g) => ({ value: g, label: configs.games[g].label }));
    fillSelect($('game'), games, configs.order[0]);
    fillSelect($('inspect-game'), games, configs.order[0]);
    selectGame(configs.order[0]);
    refreshSigning();
    refreshSheetStatus();
  })();
})();
