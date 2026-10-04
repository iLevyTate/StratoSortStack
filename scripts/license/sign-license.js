#!/usr/bin/env node

/**
 * Mint an offline-verifiable license key.
 *
 * Key format: SSORT1-<base64url(payloadJSON)>.<base64url(ed25519 signature)>
 * The signature covers the exact base64url payload segment (utf8 bytes) —
 * the same bytes LicenseService verifies — so no JSON canonicalization is
 * involved anywhere.
 *
 * The private key path comes from the STRATOSORT_LICENSE_SIGNING_KEY env var
 * (documented in docs/CONFIG.md). Intended callers: manual fulfillment, or
 * the Paddle webhook endpoint at purchase time.
 *
 * Usage:
 *   STRATOSORT_LICENSE_SIGNING_KEY=path/to/license-private-key.pem \
 *     node scripts/license/sign-license.js \
 *       --name "Ada Lovelace" --email ada@example.com \
 *       [--edition personal] [--seats 1] [--maintenance-months 12]
 */

const crypto = require('crypto');
const fs = require('fs');

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const keyPath = process.env.STRATOSORT_LICENSE_SIGNING_KEY;
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error(
    'STRATOSORT_LICENSE_SIGNING_KEY must point at the Ed25519 private key PEM (see docs/CONFIG.md).'
  );
  process.exit(1);
}

const name = arg('--name');
const email = arg('--email');
if (!name || !email) {
  console.error('Required: --name "<licensee>" --email <address>');
  process.exit(1);
}

const months = Number(arg('--maintenance-months', '12'));
const maintenanceUntil = new Date();
maintenanceUntil.setMonth(maintenanceUntil.getMonth() + (Number.isFinite(months) ? months : 12));

const payload = {
  name,
  // Email is hashed so a leaked/shared key string does not expose the address.
  emailHash: crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex'),
  edition: arg('--edition', 'personal'),
  seats: Number(arg('--seats', '1')) || 1,
  issuedAt: new Date().toISOString().slice(0, 10),
  maintenanceUntil: maintenanceUntil.toISOString().slice(0, 10)
};

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const signature = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKey);

console.log(`SSORT1-${payloadB64}.${signature.toString('base64url')}`);
