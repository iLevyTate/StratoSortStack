/**
 * Tests for shared/safeStorageEncryption.js. Network-free, fast — no
 * Electron required because the wrapper accepts an injected stub via
 * setSafeStorageOverride().
 */

const {
  encrypt,
  decryptIfNeeded,
  isEncrypted,
  isEncryptionAvailable,
  ENCRYPTION_PREFIX,
  setSafeStorageOverride
} = require('../src/shared/safeStorageEncryption');

/**
 * Reversible byte-flip stand-in for safeStorage.
 * Real safeStorage is OS-specific so we substitute a deterministic
 * transform and assert the round-trip rather than the underlying crypto.
 */
function makeStubSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`STUB::${plain}`, 'utf8'),
    decryptString: (buf) => {
      const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      if (!s.startsWith('STUB::')) throw new Error('decryptString: bad ciphertext');
      return s.slice('STUB::'.length);
    }
  };
}

afterEach(() => {
  setSafeStorageOverride(null);
});

describe('isEncryptionAvailable', () => {
  test('returns false when no safeStorage is resolvable', () => {
    setSafeStorageOverride({});
    expect(isEncryptionAvailable()).toBe(false);
  });

  test('returns false when the platform reports unavailable', () => {
    setSafeStorageOverride(makeStubSafeStorage({ available: false }));
    expect(isEncryptionAvailable()).toBe(false);
  });

  test('returns true when the stub reports available', () => {
    setSafeStorageOverride(makeStubSafeStorage({ available: true }));
    expect(isEncryptionAvailable()).toBe(true);
  });
});

describe('encrypt / decryptIfNeeded round-trip', () => {
  beforeEach(() => setSafeStorageOverride(makeStubSafeStorage()));

  test('encrypt produces a marker-prefixed payload, decryptIfNeeded recovers the original', () => {
    const plain = 'hello world';
    const encrypted = encrypt(plain);
    expect(encrypted.startsWith(ENCRYPTION_PREFIX)).toBe(true);
    expect(encrypted).not.toBe(plain);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptIfNeeded(encrypted)).toBe(plain);
  });

  test('decryptIfNeeded passes plain (no-marker) values through unchanged', () => {
    expect(decryptIfNeeded('legacy plain')).toBe('legacy plain');
    expect(decryptIfNeeded('')).toBe('');
    expect(decryptIfNeeded(null)).toBeNull();
  });

  test('encrypt is idempotent — re-encrypting an already-encrypted value is a no-op', () => {
    const once = encrypt('hello');
    const twice = encrypt(once);
    expect(twice).toBe(once);
  });

  test('encrypting empty string returns empty (no marker, no growth on the wire)', () => {
    expect(encrypt('')).toBe('');
  });

  test('encrypting a non-string returns the input unchanged', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeUndefined();
    expect(encrypt(42)).toBe(42);
  });

  test('round-trips multibyte / unicode content correctly', () => {
    const plain = 'こんにちは 世界 🌍';
    expect(decryptIfNeeded(encrypt(plain))).toBe(plain);
  });
});

describe('graceful fallback when safeStorage is unavailable', () => {
  beforeEach(() => setSafeStorageOverride(makeStubSafeStorage({ available: false })));

  test('encrypt returns plaintext unchanged (no marker)', () => {
    expect(encrypt('hello')).toBe('hello');
  });

  test('decryptIfNeeded returns "" for marker-tagged input that cannot be decrypted', () => {
    // Simulate a cross-platform handoff: a row was encrypted on a machine
    // where safeStorage worked, then read on a machine where it doesn't.
    // We return '' so the caller's JSON.parse fallback yields the empty
    // value, rather than crashing on garbled ciphertext.
    expect(decryptIfNeeded(`${ENCRYPTION_PREFIX}garbage`)).toBe('');
  });

  test('decryptIfNeeded still passes plain values through', () => {
    expect(decryptIfNeeded('legacy plain')).toBe('legacy plain');
  });
});

describe('decrypt error handling', () => {
  test('returns "" instead of throwing when ciphertext is corrupt', () => {
    setSafeStorageOverride(makeStubSafeStorage({ available: true }));
    // Marker is present but the body doesn't match the stub format
    const corrupt = `${ENCRYPTION_PREFIX}AAAA`; // valid base64, garbage after stub strips
    expect(decryptIfNeeded(corrupt)).toBe('');
  });
});

describe('isEncrypted', () => {
  test('returns true only for the exact prefix', () => {
    expect(isEncrypted(`${ENCRYPTION_PREFIX}foo`)).toBe(true);
    expect(isEncrypted('not encrypted')).toBe(false);
    expect(isEncrypted('sse:v0:foo')).toBe(false); // wrong version
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});
