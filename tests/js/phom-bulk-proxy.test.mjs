// PHASE 6.3.10 — QUICK BULK PROXY parser (pure). ONE LINE = ONE proxy (TYPE|host|port|user|pass); NEWLINE
// maps to the next profile BY ORDER (line 1 → B1). Loaded as a classic browser script via vm (same realm so
// returned objects compare with deepStrictEqual). Never echoes a credential in an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../../ui-phom/bulk-proxy.js', import.meta.url), 'utf8');
vm.runInThisContext(code);
const BP = globalThis.BulkProxy;

test('exposes ONLY the supported proxy types (no invented types) + a template', () => {
  assert.deepEqual(BP.SUPPORTED, ['http', 'https', 'socks4', 'socks5']);
  assert.match(BP.TEMPLATE, /HTTP\|HOST\|PORT\|USERNAME\|PASSWORD/);
  assert.match(BP.TEMPLATE, /SOCKS5\|/);
});

// A — three HTTP lines map to B1/B2/B3 with the exact fields.
test('A: TYPE|host|port|user|pass → correct proxy objects, mapped by order', () => {
  const r = BP.parse('HTTP|hostA|8080|userA|passA\nHTTP|hostB|8081|userB|passB\nHTTP|hostC|8082|userC|passC');
  assert.equal(r.ok, true);
  assert.deepEqual(r.proxies, [
    { protocol: 'http', host: 'hostA', port: 8080, username: 'userA', password: 'passA' },
    { protocol: 'http', host: 'hostB', port: 8081, username: 'userB', password: 'passB' },
    { protocol: 'http', host: 'hostC', port: 8082, username: 'userC', password: 'passC' },
  ]);
  const m = BP.mapToProfiles(r.proxies, ['p1', 'p2', 'p3']);
  assert.deepEqual(m.mapping.map((x) => x.profileId), ['p1', 'p2', 'p3']); // line1→B1, line2→B2, line3→B3
});

// B — SOCKS5 type preserved.
test('B: SOCKS5 type is preserved (lowercased to the canonical scheme)', () => {
  const r = BP.parse('SOCKS5|h1|1080|u|p\nSOCKS5|h2|1081|u|p\nSOCKS5|h3|1082|u|p');
  assert.equal(r.ok, true);
  assert.deepEqual(r.proxies.map((p) => p.protocol), ['socks5', 'socks5', 'socks5']);
});

// C — 2 lines for 3 profiles → B1/B2 mapped, B3 left unchanged (only 2 mappings).
test('C: fewer proxies than profiles → apply the first N, leave the rest unchanged', () => {
  const r = BP.parse('HTTP|a|1|u|p\nHTTP|b|2|u|p');
  const m = BP.mapToProfiles(r.proxies, ['p1', 'p2', 'p3']);
  assert.equal(m.ok, true);
  assert.equal(m.mapping.length, 2);
  assert.deepEqual(m.mapping.map((x) => x.profileId), ['p1', 'p2']);
});

// D — 4 lines for 3 profiles → REJECT, nothing applied.
test('D: more proxies than profiles → rejected, nothing applied', () => {
  const r = BP.parse('HTTP|a|1|u|p\nHTTP|b|2|u|p\nHTTP|c|3|u|p\nHTTP|d|4|u|p');
  const m = BP.mapToProfiles(r.proxies, ['p1', 'p2', 'p3']);
  assert.equal(m.ok, false);
  assert.match(m.error.message, /Có 4 proxy nhưng chỉ có 3 profile/);
});

// E — invalid type → reject (all-or-nothing: no proxies returned).
test('E: invalid proxy type → typed error on the exact line', () => {
  const r = BP.parse('HTTP|a|1|u|p\nFTP|b|2|u|p');
  assert.equal(r.ok, false);
  assert.equal(r.error.line, 2);
  assert.equal(r.error.field, 'TYPE');
});

// F — invalid host → reject.
test('F: empty host → typed error', () => {
  const r = BP.parse('HTTP||8080|u|p');
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'HOST');
});

// G — invalid port → reject.
test('G: out-of-range / non-numeric port → typed error', () => {
  assert.equal(BP.parse('HTTP|h|99999|u|p').error.field, 'PORT');
  assert.equal(BP.parse('HTTP|h|abc|u|p').error.field, 'PORT');
  assert.equal(BP.parse('HTTP|h|0|u|p').error.field, 'PORT');
});

// H — invalid field count → reject.
test('H: wrong field count (not 3 or 5) → typed error', () => {
  assert.equal(BP.parse('HTTP|h|8080|u').error.field, 'SỐ TRƯỜNG');       // 4
  assert.equal(BP.parse('HTTP|h').error.field, 'SỐ TRƯỜNG');             // 2
  assert.equal(BP.parse('HTTP|h|8080|u|p|extra').error.field, 'SỐ TRƯỜNG'); // 6
});

// I — whitespace around fields is trimmed.
test('I: whitespace around fields + line is trimmed', () => {
  const r = BP.parse('  HTTP | host | 8080 | user | pass ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.proxies[0], { protocol: 'http', host: 'host', port: 8080, username: 'user', password: 'pass' });
});

// J — credentials with supported special characters are preserved verbatim.
test('J: username/password with supported special chars are preserved', () => {
  const r = BP.parse('HTTP|h|8080|u.ser-01|p@ss_w0rd!');
  assert.equal(r.ok, true);
  assert.equal(r.proxies[0].username, 'u.ser-01');
  assert.equal(r.proxies[0].password, 'p@ss_w0rd!');
});

// Empty username/password (optional) → null (no auth); 3-field no-auth form.
test('empty user/pass → null (no auth); TYPE|host|port (3 fields) is accepted', () => {
  assert.deepEqual(BP.parse('HTTP|h|8080||').proxies[0], { protocol: 'http', host: 'h', port: 8080, username: null, password: null });
  assert.deepEqual(BP.parse('SOCKS5|h|1080').proxies[0], { protocol: 'socks5', host: 'h', port: 1080, username: null, password: null });
});

// Blank-line handling: trailing blanks ignored; a blank line BETWEEN proxies is an error.
test('trailing blank lines are ignored; a blank line between proxies is an error', () => {
  assert.equal(BP.parse('HTTP|h|8080|u|p\n\n').proxies.length, 1);
  const mid = BP.parse('HTTP|a|1|u|p\n\nHTTP|b|2|u|p');
  assert.equal(mid.ok, false);
  assert.equal(mid.error.line, 2);
});

// SECURITY — an error NEVER contains the credential.
test('SECURITY: parse errors never echo the username/password', () => {
  const r = BP.parse('HTTP|h|abc|secretuser|secretpass');
  assert.equal(r.ok, false);
  assert.equal(/secretuser|secretpass/.test(r.error.message), false);
});
