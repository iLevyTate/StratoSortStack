// @ts-check
/**
 * Thin wrapper around Electron's `safeStorage` with version markers and
 * graceful fallback for environments where it isn't available (tests, CI,
 * Linux distros without libsecret/kwallet).
 *
 * Storage format
 * --------------
 *   Encrypted payload: 'sse:v1:' + base64(safeStorage.encryptString(plain))
 *   Plain payload:     the original string, unchanged
 *
 * The marker prefix lets `decryptIfNeeded` distinguish encrypted from
 * plain strings on read, which is what makes lazy / opt-in migration
 * work — existing rows written before encryption was enabled stay
 * readable as-is, while new writes go through `encrypt()`.
 *
 * `safeStorage` uses OS-level keychain APIs (DPAPI on Windows, Keychain
 * on macOS, libsecret/kwallet on Linux) so encrypted payloads are tied
 * to the user account and cannot be decrypted by another user on the
 * same machine.
 *
 * @module shared/safeStorageEncryption
 */

const ENCRYPTION_PREFIX = 'sse:v1:';

/** @type {any|null} */
let _cachedSafeStorage = null;
let _cachedSafeStorageProbed = false;

/**
 * Resolve Electron's safeStorage at call time. Cached after the first
 * successful resolve; absent in renderer / Node-without-Electron envs,
 * in which case the wrapper degrades to plain pass-through.
 *
 * Tests inject a stub via `setSafeStorageOverride()` instead of
 * monkey-patching `electron`.
 *
 * @private
 */
function getSafeStorage() {
  if (_cachedSafeStorageProbed) return _cachedSafeStorage;
  _cachedSafeStorageProbed = true;
  try {
    const electron = require('electron');
    if (electron && typeof electron.safeStorage === 'object') {
      _cachedSafeStorage = electron.safeStorage;
    }
  } catch {
    /* electron unavailable — pass-through */
  }
  return _cachedSafeStorage;
}

/** @type {any|null} */
let _override = null;

/**
 * Inject a stand-in safeStorage for tests. Pass `null` to clear and
 * restore the cached resolution. The override sticks across calls so
 * tests can configure it once in `beforeEach` and clear in `afterEach`.
 */
/**
 * @param {any} stub
 */
function setSafeStorageOverride(stub) {
  _override = stub || null;
}

function _activeSafeStorage() {
  if (_override) return _override;
  return getSafeStorage();
}

/**
 * Returns true when the underlying platform can actually encrypt. False
 * on Linux distros without an unlocked keychain, in renderer processes,
 * and in test envs without an injected override.
 */
function isEncryptionAvailable() {
  const ss = _activeSafeStorage();
  if (!ss || typeof ss.isEncryptionAvailable !== 'function') return false;
  try {
    return Boolean(ss.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * Encrypt a string using safeStorage and tag it with the version marker.
 *
 * @param {string} plain - Plaintext to encrypt. Empty strings are returned
 *   unchanged (no marker) so empty fields don't grow on the wire.
 * @returns {string} Encrypted payload with `sse:v1:` prefix, OR the
 *   plaintext unchanged when encryption is unavailable. Callers should
 *   check `isEncryptionAvailable()` first if they want to know which
 *   path was taken.
 */
function encrypt(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return plain;
  if (isEncrypted(plain)) return plain; // idempotent
  const ss = _activeSafeStorage();
  if (!ss || !isEncryptionAvailable()) return plain;
  const cipherBuf = ss.encryptString(plain);
  // Buffers are returned by the real safeStorage; tests may return strings
  // directly. Normalize to base64 string.
  const base64 = Buffer.isBuffer(cipherBuf)
    ? cipherBuf.toString('base64')
    : Buffer.from(String(cipherBuf), 'utf8').toString('base64');
  return `${ENCRYPTION_PREFIX}${base64}`;
}

/**
 * Decrypt a string that was previously encrypted with `encrypt()`. Plain
 * strings (no marker) are returned unchanged so opt-in migration works:
 * old rows written before encryption was enabled remain readable.
 *
 * @param {string} value
 * @returns {string} Decrypted plaintext, or the input unchanged for plain
 *   strings, or an empty string on decrypt failure (safer than throwing —
 *   users would rather see an empty conversation row than crash the app).
 */
function decryptIfNeeded(value) {
  if (typeof value !== 'string' || !isEncrypted(value)) return value;
  const ss = _activeSafeStorage();
  if (!ss || !isEncryptionAvailable()) {
    // Marker present but no decryptor available — return empty so the
    // caller's JSON.parse fallback yields an empty array/object instead
    // of throwing on unparseable ciphertext.
    return '';
  }
  try {
    const base64 = value.slice(ENCRYPTION_PREFIX.length);
    const cipherBuf = Buffer.from(base64, 'base64');
    return ss.decryptString(cipherBuf);
  } catch {
    // Tampered ciphertext or wrong-user keychain — treat as empty so the
    // caller's parse step doesn't throw. The audit trail is the original
    // marker that's still there if the row is ever inspected manually.
    return '';
  }
}

/**
 * Returns true when the value has the encryption marker prefix.
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

module.exports = {
  encrypt,
  decryptIfNeeded,
  isEncrypted,
  isEncryptionAvailable,
  ENCRYPTION_PREFIX,
  // Test seam.
  setSafeStorageOverride
};
