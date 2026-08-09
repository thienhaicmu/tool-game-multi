(function () {
  const api = window.licenseGenerator;
  const $ = (id) => document.getElementById(id);
  const UTC_PLUS_7_OFFSET_SECONDS = 7 * 60 * 60;

  function yyyyMmDdFromSeconds(seconds) {
    return new Date((Number(seconds) + UTC_PLUS_7_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
  }

  function calcExpires() {
    $('issued').textContent = 'Trusted UTC+7';
    if ($('duration').value === 'custom') {
      $('custom-wrap').hidden = false;
      $('expires').textContent = $('custom-expiry').value || '—';
      return;
    }
    $('custom-wrap').hidden = true;
    $('expires').textContent = 'Calculated on generate';
  }

  function selectedMaxLaunches() {
    const mode = $('launch-limit').value;
    if (mode === 'unlimited') return null;
    if (mode === 'custom') return $('custom-launches').value ? Number($('custom-launches').value) : null;
    return Number(mode);
  }

  function syncLaunchLimit() {
    $('custom-launch-wrap').hidden = $('launch-limit').value !== 'custom';
  }

  async function refreshKey() {
    const status = await api.keyStatus();
    $('key-path').textContent = status.envKey ? 'Loaded from WVPT_PRIVATE_KEY environment variable' : status.privateKeyPath;
    $('key-chip').textContent = status.envKey || status.exists ? 'KEY READY' : 'KEY MISSING';
    $('key-chip').className = 'chip ' + (status.envKey || status.exists ? 'on' : 'off');
  }

  async function chooseKey() {
    await api.choosePrivateKey();
    await refreshKey();
  }

  async function generate() {
    $('error').hidden = true;
    $('generate').disabled = true;
    const result = await api.generateLicense({
      machineId: $('machine-id').value,
      mode: $('duration').value === 'custom' ? 'custom' : 'duration',
      durationDays: Number($('duration').value),
      expires: $('custom-expiry').value,
      maxLaunches: selectedMaxLaunches(),
    });
    $('generate').disabled = false;
    if (!result.ok) {
      $('error').hidden = false;
      $('error').textContent = result.error.message || result.error.code;
      return;
    }
    $('license-output').value = result.license;
    $('license-id').textContent = result.payload.licenseId;
    $('license-machine').textContent = result.payload.machineId;
    $('license-launches').textContent = result.payload.maxLaunches ? String(result.payload.maxLaunches) : 'Unlimited';
    $('copy-license').disabled = false;
    $('issued').textContent = yyyyMmDdFromSeconds(result.payload.issuedAt);
    $('expires').textContent = yyyyMmDdFromSeconds(result.payload.expiresAt);
  }

  $('duration').onchange = calcExpires;
  $('custom-expiry').oninput = calcExpires;
  $('launch-limit').onchange = syncLaunchLimit;
  $('choose-key').onclick = chooseKey;
  $('generate').onclick = generate;
  $('copy-license').onclick = () => api.copy($('license-output').value);

  calcExpires();
  syncLaunchLimit();
  refreshKey();
})();
