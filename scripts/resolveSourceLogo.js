/**
 * Resolve the master branding asset used for icons, NSIS BMPs, and DMG art.
 * Prefer the canonical SVG; fall back to legacy PNG filenames for older trees.
 */

const fs = require('fs');
const path = require('path');

/** Relative to `assets/` unless noted as repo-root relative. */
const SOURCE_LOGO_CANDIDATES = [
  path.join('icons', 'StratoSortCoreLogo.svg'),
  path.join('icons', 'png', 'StratoSortCoreLogo.png'),
  path.join('icons', 'png', 'StratoSortNewLogo.png'),
  'stratosort-logo.png'
];

/** Repo-root relative fallbacks (outside `assets/`). */
const ROOT_SOURCE_LOGO_CANDIDATES = ['StratoSortCoreLogo.svg'];

/**
 * @param {string} projectRoot - repository root (directory containing `assets/`)
 * @returns {string|null} absolute path to an existing logo file, or null
 */
function resolveSourceLogoPath(projectRoot) {
  const assetsDir = path.join(projectRoot, 'assets');
  for (const rel of SOURCE_LOGO_CANDIDATES) {
    const full = path.join(assetsDir, rel);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  for (const rel of ROOT_SOURCE_LOGO_CANDIDATES) {
    const full = path.join(projectRoot, rel);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return null;
}

/**
 * @param {string} projectRoot
 * @returns {boolean}
 */
function hasSourceLogo(projectRoot) {
  return resolveSourceLogoPath(projectRoot) !== null;
}

module.exports = {
  resolveSourceLogoPath,
  hasSourceLogo,
  SOURCE_LOGO_CANDIDATES,
  ROOT_SOURCE_LOGO_CANDIDATES
};
