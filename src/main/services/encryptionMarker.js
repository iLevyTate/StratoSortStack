// @ts-check
'use strict';

/**
 * Sidecar marker recording HOW a secret file was written, so readers branch
 * on the recorded mode instead of guessing from the current
 * `safeStorage.isEncryptionAvailable()` (which can flip between runs, e.g.
 * when a Linux keyring appears or disappears).
 *
 * @typedef {'safeStorage' | 'plaintext'} EncryptionMode
 */

const fs = require('node:fs');

/**
 * @param {boolean} encryptionAvailable
 * @returns {string} JSON payload to write next to the secret file.
 */
function serializeEncryptionMarker(encryptionAvailable) {
  return JSON.stringify({ encryption: encryptionAvailable ? 'safeStorage' : 'plaintext' });
}

/**
 * @param {string} markerPath
 * @returns {Promise<EncryptionMode | null>} null when the marker is missing
 *   (legacy file) or unrecognised; non-ENOENT read errors propagate.
 */
async function readEncryptionMarker(markerPath) {
  try {
    const raw = await fs.promises.readFile(markerPath);
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    if (parsed?.encryption === 'safeStorage' || parsed?.encryption === 'plaintext') {
      return parsed.encryption;
    }
  } catch (err) {
    if (/** @type {any} */ (err).code !== 'ENOENT') throw err;
  }
  return null;
}

module.exports = { serializeEncryptionMarker, readEncryptionMarker };
