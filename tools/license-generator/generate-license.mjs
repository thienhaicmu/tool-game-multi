import { randomBytes } from 'node:crypto';
import { sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function usage() {
  console.log(`WVPT LICENSE GENERATOR
----------------------

Usage:
  npm run license:generate -- --machine-id WVPT-PC-.... --duration 60
  npm run license:generate -- --machine-id WVPT-PC-.... --expires 2026-12-31

Private key sources:
  --private-key path
  WVPT_PRIVATE_KEY_PATH
  WVPT_PRIVATE_KEY

Duration presets: 1, 3, 7, 30, 60, 90, 180, 365 days`);
}

function readPrivateKey() {
  const direct = process.env.WVPT_PRIVATE_KEY;
  if (direct) return direct.replace(/\\n/g, '\n');
  const file = arg('--private-key', process.env.WVPT_PRIVATE_KEY_PATH || 'tools/license-generator/private/wvpt-ed25519-private.pem');
  if (!file || !existsSync(file)) throw new Error(`Private key not found: ${file}\nDO NOT COMMIT. DO NOT SHIP.`);
  return readFileSync(file, 'utf8');
}

function utcDateSeconds(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error('Custom expiry must be YYYY-MM-DD');
  const ms = Date.parse(`${dateText}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error('Invalid expiry date');
  return Math.floor(ms / 1000);
}

function buildPayload({ machineId, durationDays, expires }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = expires ? utcDateSeconds(expires) : issuedAt + Number(durationDays) * 24 * 60 * 60;
  if (!machineId) throw new Error('Machine ID is required');
  if (!/^WVPT-PC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(machineId)) throw new Error('Machine ID format is invalid');
  if (!Number.isInteger(expiresAt) || expiresAt <= issuedAt) throw new Error('Expiry must be in the future');
  const maxLaunchArg = arg('--max-launches', null);
  const maxLaunches = maxLaunchArg == null ? null : Number(maxLaunchArg);
  if (maxLaunchArg != null && (!Number.isInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > 1000000)) throw new Error('max-launches must be a whole number from 1 to 1000000');
  return {
    v: 1,
    product: 'WVPT',
    machineId,
    issuedAt,
    expiresAt,
    ...(maxLaunches ? { maxLaunches } : {}),
    licenseId: 'LIC-' + randomBytes(4).toString('hex').toUpperCase(),
  };
}

function createSignedLicense(payload, privateKeyPem) {
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  return `WVPT1.${base64url(canonical)}.${base64url(signature)}`;
}

try {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { usage(); process.exit(0); }
  const machineId = String(arg('--machine-id', '')).trim().toUpperCase();
  const expires = arg('--expires', null);
  const durationDays = Number(arg('--duration', '30'));
  if (!expires && ![1, 3, 7, 30, 60, 90, 180, 365].includes(durationDays)) throw new Error('Duration must be one of 1, 3, 7, 30, 60, 90, 180, 365 days, or use --expires YYYY-MM-DD');
  const payload = buildPayload({ machineId, durationDays, expires });
  const license = createSignedLicense(payload, readPrivateKey());
  console.log('WVPT LICENSE GENERATOR');
  console.log('----------------------');
  console.log('Machine ID:', payload.machineId);
  console.log('Issued:', new Date(payload.issuedAt * 1000).toISOString().slice(0, 10));
  console.log('Expires:', new Date(payload.expiresAt * 1000).toISOString().slice(0, 10));
  console.log('License ID:', payload.licenseId);
  console.log('');
  console.log(license);
} catch (error) {
  console.error(error.message || String(error));
  console.error('');
  usage();
  process.exit(1);
}
