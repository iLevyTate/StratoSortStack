'use strict';

/**
 * securityConfigPathLimits resolves the effective max path length, honouring
 * the Windows LongPathsEnabled registry flag. The registry probe only executes
 * on win32, so to cover it on every CI runner (ubuntu/macOS included) we mock
 * `process.platform` AND the underlying registry call rather than gating the
 * assertions behind the host platform — otherwise the probe is dead code on
 * non-Windows runners and drags the file's coverage to ~50%.
 */

const MODULE_PATH = '../../src/shared/securityConfigPathLimits';
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

// Re-require a fresh module instance (resetting its memoized probe result) with
// an optional mocked registry reader. jest.doMock is call-time (not hoisted),
// so the module's lazy require inside the probe resolves to the mock when the
// function later runs in the test body.
function loadModule(regReader) {
  jest.resetModules();
  if (regReader) {
    jest.doMock('child_process', () => ({ execFileSync: regReader }));
  }
  return require(MODULE_PATH);
}

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  jest.unmock('child_process');
  jest.resetModules();
  jest.restoreAllMocks();
});

describe('securityConfigPathLimits', () => {
  test('exposes the documented OS path ceilings', () => {
    const { MAX_PATH_LENGTHS, WIN32_LEGACY_MAX_PATH } = loadModule();
    expect(MAX_PATH_LENGTHS).toEqual({ win32: 32767, linux: 4096, darwin: 1024 });
    expect(WIN32_LEGACY_MAX_PATH).toBe(260);
  });

  describe('getEffectiveMaxPathLength', () => {
    test('returns the platform ceiling for linux and darwin', () => {
      const { getEffectiveMaxPathLength } = loadModule();
      expect(getEffectiveMaxPathLength('linux')).toBe(4096);
      expect(getEffectiveMaxPathLength('darwin')).toBe(1024);
    });

    test('falls back to the linux ceiling for an unknown platform', () => {
      const { getEffectiveMaxPathLength, MAX_PATH_LENGTHS } = loadModule();
      expect(getEffectiveMaxPathLength('sunos')).toBe(MAX_PATH_LENGTHS.linux);
    });

    test('defaults the platform argument to the host platform', () => {
      setPlatform('linux');
      const { getEffectiveMaxPathLength } = loadModule();
      expect(getEffectiveMaxPathLength()).toBe(4096);
    });

    test('on a non-Windows host, a win32 arg short-circuits to the long-path ceiling', () => {
      setPlatform('linux');
      const { getEffectiveMaxPathLength } = loadModule();
      expect(getEffectiveMaxPathLength('win32')).toBe(32767);
    });

    test('on Windows with LongPathsEnabled=1, win32 resolves to the long-path ceiling', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => 'LongPathsEnabled    REG_DWORD    0x1');
      const { getEffectiveMaxPathLength } = loadModule(regReader);
      expect(getEffectiveMaxPathLength('win32')).toBe(32767);
      expect(regReader).toHaveBeenCalledTimes(1);
    });

    test('on Windows with LongPathsEnabled=0, win32 falls back to the legacy 260 ceiling', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => 'LongPathsEnabled    REG_DWORD    0x0');
      const { getEffectiveMaxPathLength, WIN32_LEGACY_MAX_PATH } = loadModule(regReader);
      expect(getEffectiveMaxPathLength('win32')).toBe(WIN32_LEGACY_MAX_PATH);
    });
  });

  describe('isWindowsLongPathEnabled', () => {
    test('returns true (optimistic) on non-Windows hosts', () => {
      setPlatform('linux');
      const { isWindowsLongPathEnabled } = loadModule();
      expect(isWindowsLongPathEnabled()).toBe(true);
    });

    test('parses an enabled registry flag and memoizes the probe', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => 'LongPathsEnabled    REG_DWORD    0x1');
      const { isWindowsLongPathEnabled } = loadModule(regReader);
      expect(isWindowsLongPathEnabled()).toBe(true);
      // Second call is served from the memoized cache, not a fresh reg query.
      expect(isWindowsLongPathEnabled()).toBe(true);
      expect(regReader).toHaveBeenCalledTimes(1);
    });

    test('treats a disabled registry flag as no long-path support', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => 'LongPathsEnabled    REG_DWORD    0x0');
      const { isWindowsLongPathEnabled } = loadModule(regReader);
      expect(isWindowsLongPathEnabled()).toBe(false);
    });

    test('falls back to false when the registry probe throws', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => {
        throw new Error('reg.exe missing');
      });
      const { isWindowsLongPathEnabled } = loadModule(regReader);
      expect(isWindowsLongPathEnabled()).toBe(false);
    });

    test('treats a missing or garbled registry value as no support', () => {
      setPlatform('win32');
      const regReader = jest.fn(() => 'ERROR: unable to find the specified registry key');
      const { isWindowsLongPathEnabled } = loadModule(regReader);
      expect(isWindowsLongPathEnabled()).toBe(false);
    });
  });
});
