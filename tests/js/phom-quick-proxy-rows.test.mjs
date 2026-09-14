import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseQuickProxyRows } = require('../../desktop/browser-run/phom-quick-proxy.cjs');

// §4F/§6 — the NEW UI sends three slot-labeled rows. The slot is authoritative from the
// label; the user NEVER types an A=/B=/C= prefix.
test('parses three slot-labeled rows without any prefix', () => {
  const r = parseQuickProxyRows([
    { slot: 'A', protocol: 'http', value: '1.1.1.1|8080' },
    { slot: 'B', protocol: 'socks5', value: '2.2.2.2|1080|bob|pw' },
    { slot: 'C', protocol: 'https', value: '3.3.3.3|443' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.host, '1.1.1.1'); assert.equal(r.slots.A.port, 8080); assert.equal(r.slots.A.protocol, 'http');
  assert.equal(r.slots.B.protocol, 'socks5'); assert.equal(r.slots.B.username, 'bob'); assert.equal(r.slots.B.password, 'pw');
  assert.equal(r.slots.C.protocol, 'https'); assert.equal(r.slots.C.port, 443);
});

test('each row keeps its OWN protocol (no cross-mapping)', () => {
  const r = parseQuickProxyRows([
    { slot: 'A', protocol: 'socks4', value: '1.1.1.1|1' },
    { slot: 'B', protocol: 'http', value: '2.2.2.2|2' },
    { slot: 'C', protocol: 'https', value: '3.3.3.3|3' },
  ]);
  assert.equal(r.slots.A.protocol, 'socks4');
  assert.equal(r.slots.B.protocol, 'http');
  assert.equal(r.slots.C.protocol, 'https');
});

test('a URL scheme conflicting with the row selector is a typed conflict', () => {
  const r = parseQuickProxyRows([
    { slot: 'A', protocol: 'http', value: 'socks5://1.1.1.1:1080' },
    { slot: 'B', protocol: 'http', value: '2.2.2.2|2' },
    { slot: 'C', protocol: 'http', value: '3.3.3.3|3' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_PROTOCOL_CONFLICT');
});

test('missing / duplicate slots are typed errors', () => {
  assert.equal(parseQuickProxyRows([{ slot: 'A', protocol: 'http', value: '1.1.1.1|1' }]).error.code, 'PHOM_PROXY_SLOT_MISSING');
  assert.equal(parseQuickProxyRows([
    { slot: 'A', protocol: 'http', value: '1.1.1.1|1' },
    { slot: 'A', protocol: 'http', value: '1.1.1.1|1' },
    { slot: 'C', protocol: 'http', value: '3.3.3.3|3' },
  ]).error.code, 'PHOM_PROXY_SLOT_DUPLICATED');
});

test('invalid port / empty value are typed errors and never echo a credential', () => {
  const r = parseQuickProxyRows([
    { slot: 'A', protocol: 'http', value: '1.1.1.1|70000|u|topsecret' },
    { slot: 'B', protocol: 'http', value: '2.2.2.2|2' },
    { slot: 'C', protocol: 'http', value: '3.3.3.3|3' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_PROXY_PORT_INVALID');
  assert.equal(/topsecret/.test(JSON.stringify(r)), false, 'no credential in the error');
});

test('colon and pipe forms both parse; password "0" preserved', () => {
  const r = parseQuickProxyRows([
    { slot: 'A', protocol: 'http', value: '1.1.1.1:8080' },
    { slot: 'B', protocol: 'http', value: '2.2.2.2|3128|user|0' },
    { slot: 'C', protocol: 'http', value: '3.3.3.3|3' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.slots.A.port, 8080);
  assert.equal(r.slots.B.password, '0');
});
