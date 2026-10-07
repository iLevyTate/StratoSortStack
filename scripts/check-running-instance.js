/**
 * Dev guard: refuse to wipe `dist/` while a StratoSort instance is running.
 *
 * `npm run dev` begins with `npm run clean` (`rimraf dist .webpack-cache`).
 * If a second `npm run dev` is launched while an instance is still open, that
 * clean deletes `dist/preload.js` out from under the live app. On the next
 * renderer reload the preload is gone, `window.electronAPI` becomes `null`, and
 * the UI shows "Electron API not available" plus a reset onboarding flow —
 * looking exactly like catastrophic data loss even though `userData` is
 * untouched. (See createWindow.getPreloadPath(): preload always loads from
 * `dist/preload.js`.)
 *
 * The running instance records its pid in the userData lock file
 * (`.stratosort.userdata.lock`, written by core/userDataLock.js). We read it
 * here, before `clean` runs, and abort if the holder is still alive. A stale
 * lock (dead pid), a missing lock, or an unparseable/mid-write lock all let the
 * developer proceed — the app's own acquire logic handles those on next launch.
 *
 * Escape hatch: set `STRATOSORT_ALLOW_DEV_CLEAN=1` to bypass (e.g. a wedged
 * lock with no app actually running).
 *
 * @module scripts/check-running-instance
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { LOCK_FILENAME } = require('../src/main/core/userDataLock');
const pkg = require('../package.json');

/**
 * Resolve the same `userData` directory Electron uses for this app, without
 * booting Electron. Mirrors Electron's default
 * `path.join(app.getPath('appData'), app.name)` and honours the E2E override
 * applied in `simple-main.js`.
 *
 * @returns {string} Absolute path to the userData directory.
 */
function resolveUserDataPath() {
  if (process.env.STRATOSORT_E2E_USER_DATA) {
    return process.env.STRATOSORT_E2E_USER_DATA;
  }
  // simple-main.js sets `app.name = 'StratoSort Stack'` before any getPath call;
  // package.json `productName` is the canonical source for that value.
  const productName = pkg.productName || pkg.name || 'StratoSort Stack';
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        productName
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', productName);
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        productName
      );
  }
}

/**
 * @param {number} pid
 * @returns {boolean} True if a process with this pid is alive (EPERM counts —
 *   the process exists but is owned by another user).
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Inspect the userData lock and decide whether a destructive `clean` is safe.
 *
 * @param {string} [userDataPath] - Defaults to {@link resolveUserDataPath}.
 * @returns {{ blocked: boolean, pid: number|null, lockPath: string, reason: string }}
 */
function inspectRunningInstance(userDataPath = resolveUserDataPath()) {
  const lockPath = path.join(userDataPath, LOCK_FILENAME);

  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { blocked: false, pid: null, lockPath, reason: 'no-lock' };
    }
    return { blocked: false, pid: null, lockPath, reason: `unreadable:${err.code}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Mid-write or corrupt lock; userDataLock.js arbitrates staleness on the
    // next real launch. Don't block the developer here.
    return { blocked: false, pid: null, lockPath, reason: 'unparseable' };
  }
  const pid = Number.isInteger(parsed?.pid) ? parsed.pid : null;

  if (pid && isProcessAlive(pid)) {
    return { blocked: true, pid, lockPath, reason: 'instance-alive' };
  }
  return { blocked: false, pid, lockPath, reason: 'stale' };
}

function main() {
  if (process.env.STRATOSORT_ALLOW_DEV_CLEAN === '1') {
    return;
  }

  const result = inspectRunningInstance();
  if (!result.blocked) {
    return;
  }

  const lines = [
    '',
    `  \u2716 StratoSort appears to already be running (pid ${result.pid}).`,
    '',
    '  `npm run dev` starts by deleting dist/ (npm run clean). Doing that now',
    '  would remove dist/preload.js out from under the running app, breaking its',
    '  IPC bridge (window.electronAPI) and making the UI look like all data was',
    '  lost. Your data on disk is safe \u2014 this guard just prevents the footgun.',
    '',
    '  Fix: close the existing StratoSort window, then run `npm run dev` again.',
    '  If the lock is wedged (no app actually running), bypass with:',
    '',
    '      cross-env STRATOSORT_ALLOW_DEV_CLEAN=1 npm run dev',
    ''
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveUserDataPath,
  isProcessAlive,
  inspectRunningInstance
};
