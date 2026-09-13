import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseQuickProxies } = require('../../desktop/browser-run/phom-quick-proxy.cjs');

// §5 / §17.A — pure quick-3-proxy parser. Selector protocol is authoritative unless a
// line carries a scheme; credentials never appear in any error message.

test('three pipe lines without auth (positional A/B/C)', () => {
  const r = parseQuickProxies('1.1.1.1|8080\n2.2.2.2|8081\n3.3.3.3|8082', { protocol: 'http' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.slots.A, { slot: 'A', protocol: 'http', host: '1.1.1.1', port: 8080 });
  assert.equal(r.slots.B.host, '2.2.2.2'); assert.equal(r.slots.B.port, 8081);
  assert.equal(r.slots.C.port, 8082);
  // no auth => no username/password keys
  assert.equal('username' in r.slots.A, false);
  assert.equal('password' in r.slots.A, false);
});

test('three pipe lines with auth', () => {
  const r = parseQuickProxies('h1|8080|u1|p1\nh2|8081|u2|p2\nh3|8082|u3|p3', { protocol: 'socks5' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.protocol, 'socks5');
  assert.equal(r.slots.A.username, 'u1');
  assert.equal(r.slots.A.password, 'p1');
  assert.equal(r.slots.C.username, 'u3');
});

test('colon format host:port and host:port:user:pass', () => {
  const r = parseQuickProxies('h1:8080\nh2:8081:u2:p2\nh3:8082', { protocol: 'https' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.protocol, 'https');
  assert.equal(r.slots.B.username, 'u2');
  assert.equal(r.slots.B.password, 'p2');
});

test('URL format sets protocol explicitly when it matches selector', () => {
  const r = parseQuickProxies('socks5://h1:1080\nsocks5://u2:p2@h2:1081\nsocks5://h3:1082', { protocol: 'socks5' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.B.username, 'u2');
  assert.equal(r.slots.B.password, 'p2');
});

test('A/B/C prefix mapping is order-independent', () => {
  const r = parseQuickProxies('C=h3|3\nA=h1|1\nB=h2|2', { protocol: 'http' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.host, 'h1'); assert.equal(r.slots.A.port, 1);
  assert.equal(r.slots.B.host, 'h2');
  assert.equal(r.slots.C.host, 'h3');
});

test('whitespace around fields and lines is trimmed', () => {
  const r = parseQuickProxies('  h1 | 8080 \n\n  h2|8081  \n h3|8082 ', { protocol: 'http' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.host, 'h1'); assert.equal(r.slots.A.port, 8080);
  assert.equal(r.slots.C.port, 8082);
});

test('empty input is typed PHOM_PROXY_QUICK_INPUT_REQUIRED', () => {
  const r = parseQuickProxies('   ', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_QUICK_INPUT_REQUIRED');
});

test('wrong positional line count is typed', () => {
  const r = parseQuickProxies('h1|1\nh2|2', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_QUICK_LINE_COUNT_INVALID');
  const r2 = parseQuickProxies('h1|1\nh2|2\nh3|3\nh4|4', { protocol: 'http' });
  assert.equal(r2.error.code, 'PHOM_PROXY_QUICK_LINE_COUNT_INVALID');
});

test('duplicate prefixed slot is typed', () => {
  const r = parseQuickProxies('A=h1|1\nA=h2|2\nC=h3|3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_SLOT_DUPLICATED');
  assert.equal(r.error.slot, 'A');
});

test('missing prefixed slot is typed', () => {
  const r = parseQuickProxies('A=h1|1\nB=h2|2', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_SLOT_MISSING');
  assert.equal(r.error.slot, 'C');
});

test('invalid port is typed', () => {
  const r = parseQuickProxies('h1|0\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_PORT_INVALID');
  const r2 = parseQuickProxies('h1|70000\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r2.error.code, 'PHOM_PROXY_PORT_INVALID');
});

test('missing host is typed', () => {
  const r = parseQuickProxies('|8080\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_HOST_REQUIRED');
});

test('invalid selector protocol is typed', () => {
  const r = parseQuickProxies('h1|1\nh2|2\nh3|3', { protocol: 'ftp' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_PROTOCOL_INVALID');
});

test('protocol conflict between line scheme and selector is typed (never silent override)', () => {
  const r = parseQuickProxies('socks5://h1:1\nh2:2\nh3:3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_PROTOCOL_CONFLICT');
  assert.equal(r.error.slot, 'A');
  assert.equal(r.error.selector, 'http');
  assert.equal(r.error.lineProtocol, 'socks5');
});

test('malformed pipe field count is typed PHOM_PROXY_FORMAT_INVALID', () => {
  const r = parseQuickProxies('h1|1|onlyuser\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_FORMAT_INVALID');
});

test('password "0" is preserved (not dropped as falsy)', () => {
  const r = parseQuickProxies('h1|1|u1|0\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.password, '0');
  assert.equal(r.slots.A.username, 'u1');
});

test('empty username/password fields become no-auth (null → key absent)', () => {
  const r = parseQuickProxies('h1|1||\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, true);
  assert.equal('username' in r.slots.A, false);
  assert.equal('password' in r.slots.A, false);
});

test('a credential never appears in an error message', () => {
  // Force a downstream error (bad port) on a line that carries a password.
  const r = parseQuickProxies('h1|99999|user|SECRETpw\nh2|2\nh3|3', { protocol: 'http' });
  assert.equal(r.ok, false);
  assert.equal(/SECRETpw/.test(JSON.stringify(r)), false);
});
