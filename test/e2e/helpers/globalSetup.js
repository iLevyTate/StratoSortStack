/**
 * Ensures webpack-built artifacts exist and are newer than preload source before E2E.
 * Runtime loads `dist/preload.js` (see createWindow.js); stale dist breaks API contract tests.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Newest mtime of any file under dir (recursive). */
function newestMtimeMs(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        // Skip unreadable entries
      }
    }
  }
  return newest;
}

module.exports = async function globalSetup() {
  const root = path.join(__dirname, '../../..');
  const distPreload = path.join(root, 'dist', 'preload.js');
  const srcPreload = path.join(root, 'src', 'preload', 'preload.js');
  // E2E launches the webpack bundle (dist/main.js), so it must exist and be
  // newer than every main-process/shared source — a stale bundle silently
  // tests last week's code.
  const distMain = path.join(root, 'dist', 'main.js');

  let needBuild = !fs.existsSync(distPreload) || !fs.existsSync(distMain);
  if (!needBuild && fs.existsSync(srcPreload)) {
    needBuild = fs.statSync(srcPreload).mtimeMs > fs.statSync(distPreload).mtimeMs;
  }
  if (!needBuild) {
    const distMainMtime = fs.statSync(distMain).mtimeMs;
    const newestSource = Math.max(
      newestMtimeMs(path.join(root, 'src', 'main')),
      newestMtimeMs(path.join(root, 'src', 'shared'))
    );
    needBuild = newestSource > distMainMtime;
  }

  if (needBuild) {
    console.log('[E2E globalSetup] Building main+preload (webpack.main.config.js)...');
    execSync('npm run build:main:dev', { cwd: root, stdio: 'inherit' });
  }

  // Renderer bundle is not covered by build:main — rebuild when key UI sources are newer than dist/renderer.js
  const distRenderer = path.join(root, 'dist', 'renderer.js');
  const rendererMarkers = [
    'src/renderer/components/NavigationBar.jsx',
    'src/renderer/phases/WelcomePhase.jsx',
    'src/renderer/phases/SetupPhase.jsx',
    'src/renderer/phases/DiscoverPhase.jsx',
    'src/renderer/phases/OrganizePhase.jsx',
    'src/renderer/phases/CompletePhase.jsx',
    'src/renderer/components/discover/NamingSettingsModal.jsx',
    'src/renderer/components/ui/Modal.jsx'
  ];
  let needRenderer = !fs.existsSync(distRenderer);
  if (!needRenderer) {
    const distMtime = fs.statSync(distRenderer).mtimeMs;
    needRenderer = rendererMarkers.some((rel) => {
      const p = path.join(root, rel);
      return fs.existsSync(p) && fs.statSync(p).mtimeMs > distMtime;
    });
  }
  if (needRenderer) {
    console.log(
      '[E2E globalSetup] Building renderer (webpack dev) — dist/renderer.js stale or missing...'
    );
    execSync('npm run build:dev', { cwd: root, stdio: 'inherit' });
  }
};
