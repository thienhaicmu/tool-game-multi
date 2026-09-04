import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../ui/product.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../ui/product.css', import.meta.url), 'utf8');

// §12/§13/§56 — the jackpot chip is ALWAYS present (not conditionally rendered by
// gate state) and uses a prominent base treatment independent of the gate.
test('jackpot chip is always rendered and prominent by default', () => {
  assert.match(html, /id="at-jp-chip"/, 'jackpot chip element exists');
  assert.match(html, /id="at-jp-value"/, 'jackpot value element exists');
  // Base .jp-chip carries the prominent styling (border + shadow) with no gate gating.
  const base = css.match(/\.jp-chip\{[^}]*\}/);
  assert.ok(base, '.jp-chip base rule exists');
  assert.match(base[0], /border:/, 'jackpot chip has a prominent border by default (gate OFF)');
  assert.match(base[0], /box-shadow:/, 'jackpot chip has a shadow by default (gate OFF)');
});

// §16/§30/§56 — the gate ACTIVE state is a SEPARATE, additive treatment that does
// not replace or weaken the always-on jackpot highlight.
test('gate active state is additive and does not remove the jackpot highlight', () => {
  // The gate class is distinct from the base chip and the value keeps its own styling.
  assert.match(css, /\.jp-chip\.gated\{/, 'separate gated state exists');
  assert.match(css, /\.jp-gate\.waiting\{/, 'gate WAITING indicator exists');
  assert.match(css, /\.jp-gate\.ready\{/, 'gate READY indicator exists');
  // The value stays strong (mono, large, bold) in the base rule — not tied to .gated.
  assert.match(css, /\.jp-chip \.jp-value\{[^}]*font-weight:800/);
});

// §15 — unknown jackpot uses a neutral "—" treatment, never a fake 0.
test('unknown jackpot has a neutral (not zero) treatment', () => {
  assert.match(css, /\.jp-chip\.unknown\{/);
  // renderer defaults the value text to "—" (see product.js) — assert no literal 0 default.
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  assert.match(js, /jp != null \? Number\(jp\)\.toLocaleString\(\) : '—'/);
});

// §17 — the gate config (Wait for Jackpot + Minimum Jackpot) exists and defaults OFF.
test('jackpot gate config exists and is opt-in', () => {
  assert.match(html, /id="at-jp-wait"/, 'wait-for-jackpot checkbox exists');
  assert.match(html, /id="at-jp-min"/, 'minimum jackpot input exists');
  // The checkbox is a plain checkbox (unchecked by default -> gate OFF).
  assert.match(html, /<input type="checkbox" id="at-jp-wait">/);
});
