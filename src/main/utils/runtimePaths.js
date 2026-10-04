// @ts-check
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getAppRoot } = require('./bundledResourcePaths');

function _getAppRoot() {
  return getAppRoot(app);
}

function resolveRuntimeRoot() {
  const override = process.env.STRATOSORT_RUNTIME_DIR;
  if (override && override.trim()) {
    return override.trim();
  }

  const resourcesCandidate = process.resourcesPath
    ? path.join(process.resourcesPath, 'assets', 'runtime')
    : null;
  const devCandidate = path.join(_getAppRoot(), 'assets', 'runtime');

  if (
    resourcesCandidate &&
    typeof fs.existsSync === 'function' &&
    fs.existsSync(resourcesCandidate)
  ) {
    return resourcesCandidate;
  }

  return devCandidate;
}

/** @param {...string} segments */
function resolveRuntimePath(...segments) {
  return path.join(resolveRuntimeRoot(), ...segments);
}

module.exports = {
  resolveRuntimeRoot,
  resolveRuntimePath
};
