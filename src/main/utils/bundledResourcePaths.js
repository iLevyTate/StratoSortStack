// @ts-check
/**
 * Resolve bundled resource files shipped via electron-builder extraResources.
 * In development the same filenames live at the repository root (or under docs/).
 */
const path = require('path');

/** @param {any} [app] */
function getAppRoot(app) {
  try {
    const appPath = app?.getAppPath?.() || '';
    if (appPath.endsWith('src/main') || appPath.endsWith('src\\main')) {
      return path.resolve(appPath, '../..');
    }
    // Launched as `electron ./dist/main.js` (E2E / built-but-unpackaged):
    // getAppPath() is the bundle directory, not the repo root.
    if (
      path.basename(appPath) === 'dist' ||
      appPath.endsWith(`${path.sep}dist`) ||
      appPath.endsWith('dist\\')
    ) {
      return path.resolve(appPath, '..');
    }
    if (appPath) return appPath;
  } catch {
    // app.getAppPath unavailable in some test / worker contexts
  }
  return process.cwd();
}

/**
 * @param {string} filename
 * @param {any} app
 * @param {{ devRelativePath?: string }} [options]
 */
function listBundledResourceCandidates(filename, app, { devRelativePath } = {}) {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, filename));
  }
  try {
    const appRoot = getAppRoot(app);
    candidates.push(path.join(appRoot, filename));
    if (devRelativePath) {
      candidates.push(path.join(appRoot, devRelativePath));
    }
  } catch {
    // app.getAppPath unavailable in some test contexts; skip
  }
  return candidates;
}

/**
 * @param {string[]} candidates
 * @param {any} fs
 * @param {{ onCandidateError?: (path: string, err: any) => void }} [options]
 */
async function readFirstExistingResource(candidates, fs, { onCandidateError } = {}) {
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf8');
      return { path: candidate, content };
    } catch (/** @type {any} */ err) {
      if (err.code === 'ENOENT') continue;
      onCandidateError?.(candidate, err);
    }
  }
  return null;
}

/**
 * @param {string[]} candidates
 * @param {any} fs
 * @param {{ onCandidateError?: (path: string, err: any) => void }} [options]
 */
async function findFirstExistingResourcePath(candidates, fs, { onCandidateError } = {}) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (/** @type {any} */ err) {
      if (err.code === 'ENOENT') continue;
      onCandidateError?.(candidate, err);
    }
  }
  return null;
}

module.exports = {
  getAppRoot,
  listBundledResourceCandidates,
  readFirstExistingResource,
  findFirstExistingResourcePath
};
