// @ts-check
/**
 * Single-instance lock gate.
 *
 * macOS <14 (Ventura and earlier) has a historical Electron bug where
 * `app.requestSingleInstanceLock()` inside a packaged bundle can crash the
 * helper at startup. We defensively skip the Electron-level lock on packaged
 * builds running on macOS <14.
 *
 * IMPORTANT — exposure implications:
 *   Skipping the Electron lock means two copies of StratoSort can be launched
 *   simultaneously on legacy macOS. Without a secondary guard, each copy would
 *   open the same Orama vector store and SQLite databases under
 *   `app.getPath('userData')`, causing silent index corruption, lost moves,
 *   and cross-instance embedding duplication.
 *
 *   Mitigation: `src/main/core/userDataLock.js` acquires a filesystem-level
 *   lock on the userData directory before any service initializes. That lock
 *   is the authority for data integrity and cannot be overridden by
 *   STRATOSORT_FORCE_LAUNCH. Callers that skip the Electron lock here MUST
 *   still hold the userData lock before touching persistent data.
 *
 *   On macOS ≥14, Windows, and Linux the Electron lock is enabled as usual
 *   and the userData lock acts as belt-and-suspenders.
 */
const LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR = 14;

function parseMacOSMajorVersion(/** @type {any} */ systemVersion) {
  if (typeof systemVersion !== 'string' || systemVersion.length === 0) {
    return null;
  }

  const [majorPart] = systemVersion.split('.');
  const majorVersion = Number.parseInt(majorPart, 10);

  if (!Number.isInteger(majorVersion) || majorVersion < 1) {
    return null;
  }

  return majorVersion;
}

/**
 * @param {{ platform: string, isPackaged: boolean, systemVersion: string, logger?: any }} args
 */
function shouldUseSingleInstanceLock({ platform, isPackaged, systemVersion, logger }) {
  if (platform !== 'darwin' || !isPackaged) {
    return true;
  }

  const majorVersion = parseMacOSMajorVersion(systemVersion);

  if (majorVersion === null) {
    logger?.warn(
      '[STARTUP] Unable to parse macOS version for single-instance workaround; leaving lock enabled',
      { systemVersion }
    );
    return true;
  }

  return majorVersion >= LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR;
}

module.exports = {
  LEGACY_MACOS_SINGLE_INSTANCE_LOCK_DISABLED_BELOW_MAJOR,
  parseMacOSMajorVersion,
  shouldUseSingleInstanceLock
};
