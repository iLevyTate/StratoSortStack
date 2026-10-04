// @ts-check
/**
 * Windows long-path probing and effective max path length.
 * Kept separate from securityConfig.js so preload (webpack target: web) can
 * substitute a stub that never requires Node's child_process.
 */

/**
 * Path length limits by platform
 * These are OS-imposed limits that shouldn't change
 * @type {Record<string, number>}
 */
const MAX_PATH_LENGTHS = {
  win32: 32767,
  linux: 4096,
  darwin: 1024
};

/**
 * Legacy Windows MAX_PATH (ANSI API cap). The NUL terminator brings the
 * effective limit to 259 characters; we keep the constant at 260 to match
 * WinAPI documentation and compare with `path.length`.
 */
const WIN32_LEGACY_MAX_PATH = 260;

/** @type {boolean|null} */
let cachedWindowsLongPathSupport = null;

/**
 * Best-effort probe for Windows long-path (>260 char) support. Queries the
 * `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`
 * registry value synchronously via `reg query`. Runs at most once per
 * process; the result is memoized.
 *
 * Never throws: on any error (permission, missing `reg.exe`, non-Windows)
 * we fall back to the conservative MAX_PATH limit.
 */
function isWindowsLongPathEnabled() {
  if (process.platform !== 'win32') return true;
  if (cachedWindowsLongPathSupport !== null) return cachedWindowsLongPathSupport;

  try {
    const { execFileSync } = require('child_process');
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        windowsHide: true,
        encoding: 'utf8'
      }
    );
    const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(output);
    cachedWindowsLongPathSupport = Boolean(match && parseInt(match[1], 16) !== 0);
  } catch {
    cachedWindowsLongPathSupport = false;
  }
  return cachedWindowsLongPathSupport;
}

/**
 * Returns the effective max path length for the current platform. On
 * Windows, honours the LongPathsEnabled registry flag so we don't cheer-
 * fully accept 32KB paths that the filesystem will actually reject.
 *
 * @param {string} [platform=process.platform]
 * @returns {number}
 */
function getEffectiveMaxPathLength(platform = process.platform) {
  const platformCeiling = MAX_PATH_LENGTHS[platform] || MAX_PATH_LENGTHS.linux;
  if (platform !== 'win32') return platformCeiling;
  return isWindowsLongPathEnabled() ? platformCeiling : WIN32_LEGACY_MAX_PATH;
}

module.exports = {
  MAX_PATH_LENGTHS,
  WIN32_LEGACY_MAX_PATH,
  isWindowsLongPathEnabled,
  getEffectiveMaxPathLength
};
