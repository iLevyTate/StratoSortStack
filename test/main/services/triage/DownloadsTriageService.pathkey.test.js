/**
 * @jest-environment node
 */

describe('DownloadsTriageService.triagePathKey', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  test('POSIX preserves case (distinct keys for differing case)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    jest.resetModules();
    const {
      triagePathKey
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const a = triagePathKey('/tmp/Readme.pdf');
    const b = triagePathKey('/tmp/readme.pdf');
    expect(a).not.toBe(b);
  });

  test('win32 folds case for matching keys', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.resetModules();
    const {
      triagePathKey
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const a = triagePathKey('C:\\a\\Readme.pdf');
    const b = triagePathKey('C:\\a\\readme.pdf');
    expect(a).toBe(b);
  });

  test('darwin folds case (case-insensitive default volume parity)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    jest.resetModules();
    const {
      triagePathKey
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    expect(triagePathKey('/Users/me/Readme.pdf')).toBe(triagePathKey('/Users/me/readme.pdf'));
  });

  test('NFD and NFC unicode variants collapse to the same key', () => {
    // "café" written with composed é (NFC: U+00E9) vs decomposed e + ◌́ (NFD: U+0065 U+0301).
    // macOS APFS often surfaces NFD; user-typed paths and most APIs use NFC. Without NFC
    // canonicalization in the key, scanner rows would survive `stripSessionPaths` after a
    // successful organize move because the normalized destination key would not match.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    jest.resetModules();
    const {
      triagePathKey
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const nfc = '/tmp/café.pdf';
    const nfd = '/tmp/café.pdf';
    expect(nfc).not.toBe(nfd); // sanity: distinct code-unit sequences
    expect(triagePathKey(nfc)).toBe(triagePathKey(nfd));
  });

  test('win32 normalizes backslash and forward-slash variants to the same key', () => {
    // `validateFileOperationPath` may emit forward-slash separators while the
    // scanner records backslashes; both must produce the same key so
    // `stripSessionPaths` finds the row after an organize move.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.resetModules();
    const {
      triagePathKey
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    expect(triagePathKey('C:\\Users\\me\\file.pdf')).toBe(triagePathKey('C:/Users/me/file.pdf'));
  });
});

describe('DownloadsTriageService.buildTriageScanIgnorePatterns', () => {
  test('maps ** globs to directory basenames and keeps *.ext patterns', () => {
    const {
      buildTriageScanIgnorePatterns
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const p = buildTriageScanIgnorePatterns(['node_modules/**', '*.iso', 'README.md']);
    expect(p).toEqual(expect.arrayContaining(['node_modules', '*.iso', 'README.md']));
  });
});
