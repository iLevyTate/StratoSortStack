// @ts-check
/**
 * Preload/webpack-web substitute for securityConfigPathLimits.js.
 * Cannot call `reg query` or require('child_process'); assume modern Windows
 * long-path ceiling so we do not truncate valid paths in the sandbox. Main
 * and IPC handlers still apply the real registry-backed limit for file I/O.
 */

/** @type {Record<string, number>} */
const MAX_PATH_LENGTHS = {
  win32: 32767,
  linux: 4096,
  darwin: 1024
};

const WIN32_LEGACY_MAX_PATH = 260;

function isWindowsLongPathEnabled() {
  // Optimistic stub: real probe runs in main / Node bundles only.
  return true;
}

function getEffectiveMaxPathLength(platform = process.platform) {
  const platformCeiling = MAX_PATH_LENGTHS[platform] || MAX_PATH_LENGTHS.linux;
  if (platform !== 'win32') return platformCeiling;
  return platformCeiling;
}

module.exports = {
  MAX_PATH_LENGTHS,
  WIN32_LEGACY_MAX_PATH,
  isWindowsLongPathEnabled,
  getEffectiveMaxPathLength
};
