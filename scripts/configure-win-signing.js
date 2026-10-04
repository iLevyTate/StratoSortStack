#!/usr/bin/env node
'use strict';

/**
 * Injects Azure Trusted Signing options into an electron-builder config file.
 *
 * CI-only: the Windows release workflow runs this when the Azure signing
 * credentials are present. The azureSignOptions block must NOT live in the
 * committed configs — electron-builder attempts Azure signing whenever the
 * block exists, which would break local and fork builds that have no Azure
 * credentials.
 *
 * The four signing-identity fields are public (visible in the Azure portal and
 * on the issued certificate) and stable, so they are hardcoded below rather
 * than threaded through workflow env. Each may still be overridden by the
 * matching legacy AZURE_SIGNING_* env var if one is set.
 *
 * Authentication (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) is
 * read by electron-builder's Invoke-TrustedSigning call at build time, not by
 * this script.
 *
 * Usage: node scripts/configure-win-signing.js <electron-builder-config.json>
 */

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`configure-win-signing: ${message}`);
  process.exit(1);
}

const configArg = process.argv[2];
if (!configArg) {
  fail('usage: node scripts/configure-win-signing.js <electron-builder-config.json>');
}

const DEFAULTS = {
  publisherName: 'Kennedy Applied Sciences, Inc.',
  endpoint: 'https://eus.codesigning.azure.net/',
  certificateProfileName: 'stratosortcore-public-trust-cert',
  codeSigningAccountName: 'stratosort-signing'
};

const ENV_OVERRIDES = {
  publisherName: 'AZURE_SIGNING_PUBLISHER_NAME',
  endpoint: 'AZURE_SIGNING_ENDPOINT',
  codeSigningAccountName: 'AZURE_SIGNING_ACCOUNT_NAME',
  certificateProfileName: 'AZURE_SIGNING_PROFILE_NAME'
};

const azureSignOptions = {};
for (const [field, value] of Object.entries(DEFAULTS)) {
  const override = (process.env[ENV_OVERRIDES[field]] || '').trim();
  azureSignOptions[field] = override || value;
}

const configPath = path.resolve(configArg);
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  fail(`cannot read ${configPath}: ${error.message}`);
}

config.win = { ...config.win, azureSignOptions };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `Enabled Azure Trusted Signing in ${path.basename(configPath)} ` +
    `(account: ${azureSignOptions.codeSigningAccountName}, profile: ${azureSignOptions.certificateProfileName})`
);
