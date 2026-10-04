#!/usr/bin/env node

/**
 * One-time Ed25519 keypair generation for license signing.
 *
 * Run this on an OFFLINE machine for production. The PRIVATE key must never
 * enter the repository or any CI secret store reachable by builds — it is
 * only needed by scripts/license/sign-license.js at purchase-fulfillment
 * time. The PUBLIC key goes into src/shared/licensePublicKey.js.
 *
 * Usage: node scripts/license/generate-keypair.js [outDir]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;
const privPath = path.join(outDir, 'license-private-key.pem');
const pubPath = path.join(outDir, 'license-public-key.pem');

if (fs.existsSync(privPath)) {
  console.error(`Refusing to overwrite existing private key: ${privPath}`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

console.log(`Private key: ${privPath}  (KEEP OFFLINE — never commit, never put in CI)`);
console.log(`Public key:  ${pubPath}`);
console.log('Next: paste the public key into src/shared/licensePublicKey.js');
