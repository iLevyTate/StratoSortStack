// @ts-check
/**
 * Destination policy for file writes requested over IPC (move, copy, batch
 * organize).
 *
 * A renderer may only ask main to place a file where the user has already
 * shown intent: inside a Smart Folder, in a folder picked through a native
 * dialog this session, in Downloads, under the app's own data directory, or in
 * the file's current folder (a rename in place). Any other folder is put to
 * the user in a main-process dialog, once per folder per session, so a
 * compromised renderer cannot choose a landing place on its own. Autostart
 * folders are refused outright, and a network (UNC) destination is accepted
 * only inside a Smart Folder the user registered on that share.
 *
 * The optional STRATOSORT_STRICT_FILE_OPS allowlist (userData plus watched
 * Smart Folder roots, applied to sources and destinations) lives here too so
 * single and batch operations share one builder.
 *
 * @module ipc/files/destinationPolicy
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { getEnvBool } = require('../../../shared/configDefaults');
const { isUNCPath } = require('../../../shared/crossPlatformUtils');

/** @typedef {import('../ipcWrappers').LoggerLike} LoggerLike */

/**
 * @typedef {Object} DestinationDecision
 * @property {boolean} allowed
 * @property {string} reason  Why: 'smart-folder' | 'session-folder' | 'downloads' | 'user-data' |
 *   'same-folder' | 'confirmed' | 'e2e' | 'autostart' | 'unc' | 'declined' | 'no-dialog' |
 *   'missing' | 'aborted'
 * @property {string} [error]
 * @property {string} [errorCode]
 */

/**
 * @typedef {Object} PolicyDeps
 * @property {string|null} [sourcePath]  The file being moved or copied (rename in place is allowed)
 * @property {(() => any)|null} [getServiceIntegration]
 * @property {(() => any)|null} [getMainWindow]
 * @property {LoggerLike|null} [log]
 * @property {{ count?: number, name?: string }} [intent]  What the dialog should say is being placed
 * @property {any} [dialog]  Electron dialog override (tests)
 * @property {any} [app]  Electron app override (tests)
 * @property {string} [platform]  Platform override (tests)
 * @property {Record<string, string|undefined>} [env]  Environment override (tests)
 * @property {string} [home]  Home directory override (tests)
 * @property {AbortSignal|null} [abortSignal]  The IPC request's signal. The preload gives up on
 *   an invoke after its timeout and tells main so; a dialog still open then is closed as
 *   cancelled, and an answer that arrives after the abort is not acted on.
 * @property {((p: string) => Promise<string>)|null} [realpath]  Override for tests
 * @property {string|null} [linkTarget]  Set by authorizeDestination when the landing folder is
 *   reached through a link, so the prompt can name where files will really go
 * @property {string[]} [knownRoots]  Extra folders trusted by the caller (Documents for Smart
 *   Folder registration, the Smart Folders already on record)
 * @property {{ message?: string, detail?: string }} [promptCopy]  Dialog wording for a caller
 *   that is not placing files (registering a Smart Folder, creating a folder)
 */

const DESTINATION_ERROR_CODES = Object.freeze({
  AUTOSTART: 'DESTINATION_AUTOSTART',
  UNC: 'DESTINATION_UNC',
  NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED',
  ABORTED: 'ABORTED'
});

const NO_PROVIDER_MESSAGE =
  'Destination folder was not approved. Choose a Smart Folder or pick the folder in a file dialog.';

/** Folders the user approved through the main-process dialog this session (key → path). */
/** @type {Map<string, string>} */
const _approvedDirs = new Map();
/** In-flight prompts by folder key, so a batch asks once per folder. */
/** @type {Map<string, Promise<DestinationDecision>>} */
const _pendingPrompts = new Map();

/**
 * @param {string} platform
 * @returns {boolean}
 */
function isCaseInsensitivePlatform(platform) {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * @param {string} platform
 * @returns {path.PlatformPath}
 */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Lookup key for a directory: resolved, trailing separators dropped, and
 * case-folded on platforms whose file systems ignore case.
 * @param {string} dirPath
 * @param {string} [platform]
 * @returns {string}
 */
function dirKey(dirPath, platform = process.platform) {
  const p = pathFor(platform);
  const resolved = p.resolve(dirPath);
  return isCaseInsensitivePlatform(platform) ? resolved.toLowerCase() : resolved;
}

/**
 * True when `childPath` is `parentPath` or lies under it, by path segments.
 * @param {string} childPath
 * @param {string} parentPath
 * @param {string} [platform]
 * @returns {boolean}
 */
function isWithin(childPath, parentPath, platform = process.platform) {
  const p = pathFor(platform);
  const fold = isCaseInsensitivePlatform(platform)
    ? (/** @type {string} */ s) => s.toLowerCase()
    : (/** @type {string} */ s) => s;
  const rel = p.relative(fold(p.resolve(parentPath)), fold(p.resolve(childPath)));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * Where `dirPath` really is, with links resolved. The deepest existing
 * ancestor is resolved and the rest of the path re-attached, so a folder
 * that does not exist yet still resolves through a linked parent. Returns
 * `dirPath` itself when nothing can be resolved: a foreign-platform path
 * (tests), a file system without realpath (mocks), or an error other than
 * a missing segment. Lexical checks still apply in every case.
 * @param {string} dirPath
 * @param {string} platform
 * @param {PolicyDeps} deps
 * @returns {Promise<string>}
 */
async function resolveRealDir(dirPath, platform, deps) {
  const realpath =
    typeof deps.realpath === 'function'
      ? deps.realpath
      : platform === process.platform
        ? fs.promises?.realpath
        : null;
  if (typeof realpath !== 'function') return dirPath;
  const p = pathFor(platform);
  let probe = p.resolve(dirPath);
  /** @type {string[]} */
  const tail = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      const real = await realpath(probe);
      if (typeof real !== 'string' || !real) return dirPath;
      return tail.length > 0 ? p.join(real, ...tail) : real;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return dirPath;
      const parent = p.dirname(probe);
      if (parent === probe) return dirPath;
      tail.unshift(p.basename(probe));
      probe = parent;
    }
  }
  return dirPath;
}

/**
 * Folders the operating system runs at login. A file placed here runs on the
 * next sign-in, so no file operation may land in one.
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string }} [deps]
 * @returns {string[]}
 */
function getAutostartLocations({ platform = process.platform, env = process.env, home } = {}) {
  const homeDir = home !== undefined ? home : os.homedir();
  /** @type {string[]} */
  const locations = [];
  if (platform === 'win32') {
    const startup = path.win32.join('Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (env.APPDATA) locations.push(path.win32.join(env.APPDATA, startup));
    if (env.ProgramData) locations.push(path.win32.join(env.ProgramData, startup));
    if (homeDir) locations.push(path.win32.join(homeDir, 'AppData', 'Roaming', startup));
  } else if (platform === 'darwin') {
    if (homeDir) {
      locations.push(
        path.posix.join(homeDir, 'Library', 'LaunchAgents'),
        path.posix.join(homeDir, 'Library', 'StartupItems')
      );
    }
    locations.push(
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      '/Library/StartupItems',
      '/System/Library/LaunchAgents',
      '/System/Library/LaunchDaemons'
    );
  } else {
    if (homeDir) locations.push(path.posix.join(homeDir, '.config', 'autostart'));
    locations.push('/etc/xdg/autostart');
  }
  return locations;
}

/**
 * @param {string} targetPath
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string }} [deps]
 * @returns {boolean}
 */
function isAutostartLocation(targetPath, deps = {}) {
  const platform = deps.platform || process.platform;
  return getAutostartLocations({ platform, env: deps.env, home: deps.home }).some((location) =>
    isWithin(targetPath, location, platform)
  );
}

/**
 * The startup folder `dir`, or its link-resolved form `realDir`, lands in;
 * null when neither does. `realDir` is held against the startup folders as
 * they really are as well as as written: a startup folder reached through a
 * linked ancestor (macOS /var -> /private/var, a dotfile-managed ~/.config,
 * a Windows 8.3 alias) is canonical on one side only until both are
 * resolved. A startup folder that does not exist resolves through its
 * deepest existing ancestor, as any other folder does.
 * @param {string} dir
 * @param {string} realDir
 * @param {string} platform
 * @param {PolicyDeps} deps
 * @returns {Promise<string|null>}
 */
async function findAutostartLanding(dir, realDir, platform, deps) {
  if (isAutostartLocation(dir, deps)) return dir;
  if (dirKey(realDir, platform) === dirKey(dir, platform)) return null;
  if (isAutostartLocation(realDir, deps)) return realDir;
  const locations = getAutostartLocations({ platform, env: deps.env, home: deps.home });
  for (const location of locations) {
    const realLocation = await resolveRealDir(location, platform, deps);
    if (isWithin(realDir, realLocation, platform)) return realDir;
  }
  return null;
}

/**
 * Record a folder the user picked in a native dialog; moves and copies into
 * it need no further confirmation this session.
 * @param {string} dirPath
 */
function rememberUserChosenLocation(dirPath, platform = process.platform) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return;
  const resolved = pathFor(platform).resolve(dirPath.trim());
  _approvedDirs.set(dirKey(resolved, platform), resolved);
}

function safeElectron() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

/**
 * Every configured Smart Folder path main can see.
 * @param {(() => any)|null|undefined} getServiceIntegration
 * @returns {string[]}
 */
function getSmartFolderPaths(getServiceIntegration) {
  /** @type {Set<string>} */
  const paths = new Set();
  try {
    const integration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    const watcher = integration?.smartFolderWatcher;
    const folders = watcher?.getSmartFolders?.();
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (typeof folder?.path === 'string' && folder.path) paths.add(folder.path);
    }
    const watched = watcher?.watchedPaths;
    if (watched && typeof watched[Symbol.iterator] === 'function') {
      for (const root of watched) {
        if (typeof root === 'string' && root) paths.add(root);
      }
    }
  } catch {
    // Service integration may be unavailable early in boot; fall through.
  }
  try {
    const { container, ServiceIds } = require('../../services/ServiceContainer');
    if (container?.has?.(ServiceIds.LEARNING_FEEDBACK)) {
      const folders = container.resolve(ServiceIds.LEARNING_FEEDBACK)?.getSmartFolders?.();
      for (const folder of Array.isArray(folders) ? folders : []) {
        if (typeof folder?.path === 'string' && folder.path) paths.add(folder.path);
      }
    }
  } catch {
    // Container may be mocked or not yet populated.
  }
  return [...paths];
}

/**
 * Roots a destination may fall under without a prompt, with the reason each
 * one is trusted.
 * @param {PolicyDeps} [deps]
 * @returns {Array<{ root: string, reason: string }>}
 */
function getAllowedDestinationRoots(deps = {}) {
  /** @type {Array<{ root: string, reason: string }>} */
  const roots = [];
  for (const folderPath of getSmartFolderPaths(deps.getServiceIntegration)) {
    roots.push({ root: folderPath, reason: 'smart-folder' });
  }
  const electronApp = deps.app || safeElectron()?.app;
  for (const [name, reason] of [
    ['userData', 'user-data'],
    ['downloads', 'downloads']
  ]) {
    try {
      const resolved = electronApp?.getPath?.(name);
      if (typeof resolved === 'string' && resolved) roots.push({ root: resolved, reason });
    } catch {
      // A path Electron cannot resolve on this platform is simply not a root.
    }
  }
  for (const dir of _approvedDirs.values()) {
    roots.push({ root: dir, reason: 'session-folder' });
  }
  for (const root of Array.isArray(deps.knownRoots) ? deps.knownRoots : []) {
    if (typeof root === 'string' && root.trim()) roots.push({ root, reason: 'known-root' });
  }
  return roots;
}

/**
 * Whether the user picked `dirPath` in a native dialog this session.
 * @param {string} dirPath
 * @param {string} [platform]
 * @returns {boolean}
 */
function isUserChosenLocation(dirPath, platform = process.platform) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  return _approvedDirs.has(dirKey(dirPath, platform));
}

/**
 * Optional strict-mode allowlist builder.
 *
 * When `STRATOSORT_STRICT_FILE_OPS=true` is set, file-operation IPC (single
 * move, copy and delete, and batch organize) is restricted to paths under
 * either (a) a watched smart-folder root or (b) the app's `userData`
 * directory. Off by default because users drag files in from arbitrary
 * locations; opt-in gives security-sensitive deployments a defense-in-depth
 * layer on sources as well as destinations.
 *
 * @param {(() => any)|null|undefined} getServiceIntegration
 * @returns {{ enabled: boolean, allowlist: string[] }}
 */
function buildStrictFileOpsAllowlist(getServiceIntegration) {
  const flag = process.env.STRATOSORT_STRICT_FILE_OPS;
  if (!flag || String(flag).toLowerCase() !== 'true') {
    return { enabled: false, allowlist: [] };
  }
  /** @type {string[]} */
  const allowlist = [];
  try {
    const userData = safeElectron()?.app?.getPath?.('userData');
    if (userData) allowlist.push(path.resolve(userData));
  } catch {
    // Electron may be unavailable in unit tests; fall through.
  }
  try {
    const smartFolderWatcher =
      typeof getServiceIntegration === 'function'
        ? getServiceIntegration()?.smartFolderWatcher
        : null;
    const watched = smartFolderWatcher?.watchedPaths;
    if (watched && typeof watched[Symbol.iterator] === 'function') {
      for (const root of watched) {
        if (typeof root === 'string' && root.length > 0) {
          allowlist.push(path.resolve(root));
        }
      }
    }
  } catch {
    // If watched paths cannot be read the validator treats the (likely
    // empty) allowlist as blocking everything: fail closed under strict mode.
  }
  return { enabled: true, allowlist };
}

/**
 * @param {{ count?: number, name?: string }|undefined} intent
 * @returns {string}
 */
function describeIntent(intent) {
  const count = Number(intent?.count);
  if (Number.isFinite(count) && count > 1) return `${count} files`;
  if (typeof intent?.name === 'string' && intent.name) return `"${intent.name}"`;
  return 'this file';
}

/**
 * Ask the user, in a main-process dialog, whether files may be placed in a
 * folder the app was not already told about.
 * @param {string} destDir
 * @param {PolicyDeps} deps
 * @returns {Promise<DestinationDecision>}
 */
async function askUser(destDir, deps) {
  const electron = safeElectron();
  const electronApp = deps.app || electron?.app;
  const dlg = deps.dialog || electron?.dialog;
  const log = deps.log;
  const signal = deps.abortSignal instanceof AbortSignal ? deps.abortSignal : null;
  const aborted = () => ({
    allowed: false,
    reason: 'aborted',
    errorCode: DESTINATION_ERROR_CODES.ABORTED,
    error: 'The request was cancelled before the destination folder was confirmed.'
  });
  if (signal?.aborted) return aborted();

  // Playwright cannot drive native dialogs; unpackaged e2e runs approve and say so.
  if (electronApp && !electronApp.isPackaged && getEnvBool('STRATOSORT_E2E')) {
    log?.info?.('[FILE-OPS] Destination approved without a dialog under STRATOSORT_E2E', {
      destDir
    });
    return { allowed: true, reason: 'e2e' };
  }
  if (typeof dlg?.showMessageBox !== 'function') {
    log?.warn?.('[FILE-OPS] Destination refused: no dialog available to confirm it', {
      destDir
    });
    return {
      allowed: false,
      reason: 'no-dialog',
      errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED,
      error: NO_PROVIDER_MESSAGE
    };
  }

  const linkNote =
    typeof deps.linkTarget === 'string' && deps.linkTarget
      ? ` This folder is a link; the files will really be placed in ${deps.linkTarget}.`
      : '';
  const options = {
    type: 'question',
    buttons: ['Allow for this session', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Allow this folder?',
    message: deps.promptCopy?.message || `Put ${describeIntent(deps.intent)} in ${destDir}?`,
    detail:
      (deps.promptCopy?.detail ||
        'This folder is not one of your Smart Folders and was not chosen in a file dialog during this session. Allowing it lets StratoSort place files there until the app closes.') +
      linkNote,
    // Electron closes the box as cancelled when the signal fires, so a
    // request the renderer has given up on does not leave a dialog behind.
    ...(signal ? { signal } : {})
  };
  let response;
  try {
    const win = typeof deps.getMainWindow === 'function' ? deps.getMainWindow() : null;
    const result =
      win && !win.isDestroyed?.()
        ? await dlg.showMessageBox(win, options)
        : await dlg.showMessageBox(options);
    response = result?.response;
  } catch (err) {
    log?.warn?.('[FILE-OPS] Destination dialog failed; destination refused', {
      destDir,
      error: err?.message
    });
    return {
      allowed: false,
      reason: 'no-dialog',
      errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED,
      error: NO_PROVIDER_MESSAGE
    };
  }
  // An answer given after the renderer abandoned the request is not acted
  // on and not remembered: the operation it would have approved is gone.
  if (signal?.aborted) {
    log?.info?.('[FILE-OPS] Destination answer arrived after the request was cancelled', {
      destDir
    });
    return aborted();
  }
  if (response === 0) return { allowed: true, reason: 'confirmed' };
  return {
    allowed: false,
    reason: 'declined',
    errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED,
    error: `Destination folder was not approved: ${destDir}`
  };
}

/**
 * One prompt per folder even when several operations race for it.
 * @param {string} destDir
 * @param {PolicyDeps} deps
 * @returns {Promise<DestinationDecision>}
 */
function promptForFolder(destDir, deps) {
  const platform = deps.platform || process.platform;
  const key = dirKey(destDir, platform);
  const pending = _pendingPrompts.get(key);
  if (pending) return pending;
  const prompt = (async () => {
    try {
      const decision = await askUser(destDir, deps);
      if (decision.allowed) _approvedDirs.set(key, pathFor(platform).resolve(destDir));
      return decision;
    } finally {
      _pendingPrompts.delete(key);
    }
  })();
  _pendingPrompts.set(key, prompt);
  return prompt;
}

/**
 * Decide whether a file may be placed at `destination`.
 * @param {string} destination  Full destination file path
 * @param {PolicyDeps} [deps]
 * @returns {Promise<DestinationDecision>}
 */
async function authorizeDestination(destination, deps = {}) {
  if (typeof destination !== 'string' || !destination.trim()) {
    return {
      allowed: false,
      reason: 'missing',
      errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED,
      error: 'Destination path is missing.'
    };
  }
  const platform = deps.platform || process.platform;
  const p = pathFor(platform);
  const destDir = p.dirname(p.resolve(destination));
  // A link inside a Smart Folder can point anywhere, a startup folder
  // included. Decide on where the files will really land as well as on the
  // path as written.
  const realDestDir = await resolveRealDir(destDir, platform, deps);
  const isLinked = dirKey(realDestDir, platform) !== dirKey(destDir, platform);

  const startupFolder = await findAutostartLanding(destDir, realDestDir, platform, deps);
  if (startupFolder) {
    return {
      allowed: false,
      reason: 'autostart',
      errorCode: DESTINATION_ERROR_CODES.AUTOSTART,
      error: `Destination is a startup folder (${startupFolder}); StratoSort will not place files where the operating system runs them at login.`
    };
  }

  for (const { root, reason } of getAllowedDestinationRoots(deps)) {
    if (!isWithin(destDir, root, platform)) continue;
    if (!isLinked) return { allowed: true, reason };
    // The folder is under a trusted root as written; it must also be under
    // that root once links are resolved, or the trust does not carry.
    const realRoot = await resolveRealDir(root, platform, deps);
    if (isWithin(realDestDir, realRoot, platform)) return { allowed: true, reason };
    deps.log?.info?.('[FILE-OPS] Destination is a link out of a trusted folder; asking', {
      destDir,
      realDestDir,
      root
    });
  }

  if (typeof deps.sourcePath === 'string' && deps.sourcePath) {
    const sourceDir = p.dirname(p.resolve(deps.sourcePath));
    if (dirKey(sourceDir, platform) === dirKey(destDir, platform)) {
      return { allowed: true, reason: 'same-folder' };
    }
  }

  if (isUNCPath(destination) || isUNCPath(destDir) || (isLinked && isUNCPath(realDestDir))) {
    return {
      allowed: false,
      reason: 'unc',
      errorCode: DESTINATION_ERROR_CODES.UNC,
      error: 'Network destinations are allowed only inside a Smart Folder on that share.'
    };
  }

  return promptForFolder(destDir, isLinked ? { ...deps, linkTarget: realDestDir } : deps);
}

/**
 * Decide whether `folderPath` may become a Smart Folder root. From then on
 * every move into it needs no prompt, so the bar is the one a destination
 * meets: a startup folder is refused; a folder picked in a dialog this
 * session, or inside a root already trusted (a Smart Folder on record,
 * Downloads, the app data folder, the caller's `knownRoots`), or beside the
 * root it replaces (a rename), is allowed; anything else is put to the user.
 * Links are resolved first, as for a destination.
 * @param {string} folderPath
 * @param {PolicyDeps} [deps]
 * @returns {Promise<DestinationDecision>}
 */
async function authorizeSmartFolderRoot(folderPath, deps = {}) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    return {
      allowed: false,
      reason: 'missing',
      errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED,
      error: 'Folder path is missing.'
    };
  }
  const platform = deps.platform || process.platform;
  const p = pathFor(platform);
  const dir = p.resolve(folderPath);
  const realDir = await resolveRealDir(dir, platform, deps);
  const isLinked = dirKey(realDir, platform) !== dirKey(dir, platform);

  const startupFolder = await findAutostartLanding(dir, realDir, platform, deps);
  if (startupFolder) {
    return {
      allowed: false,
      reason: 'autostart',
      errorCode: DESTINATION_ERROR_CODES.AUTOSTART,
      error: `${startupFolder} is a startup folder; StratoSort will not organize files into a folder the operating system runs at login.`
    };
  }

  if (isUserChosenLocation(dir, platform)) return { allowed: true, reason: 'session-folder' };

  for (const { root, reason } of getAllowedDestinationRoots(deps)) {
    if (!isWithin(dir, root, platform)) continue;
    if (!isLinked) return { allowed: true, reason };
    const realRoot = await resolveRealDir(root, platform, deps);
    if (isWithin(realDir, realRoot, platform)) return { allowed: true, reason };
  }

  // Renaming a Smart Folder beside the one it replaces keeps the parent the
  // user already accepted.
  if (typeof deps.sourcePath === 'string' && deps.sourcePath) {
    const previousParent = p.dirname(p.resolve(deps.sourcePath));
    if (dirKey(previousParent, platform) === dirKey(p.dirname(dir), platform)) {
      return { allowed: true, reason: 'same-folder' };
    }
  }

  return promptForFolder(dir, {
    ...deps,
    linkTarget: isLinked ? realDir : null,
    promptCopy: {
      message: `Use ${dir} as a Smart Folder?`,
      detail:
        'StratoSort will place the files it organizes into this folder without asking again. The folder was not chosen in a file dialog during this session.'
    }
  });
}

/**
 * Decide a batch of operations folder by folder: one decision (and at most
 * one dialog) per landing folder, asked in sequence so dialogs never stack.
 *
 * The same-folder exemption is per operation, never per folder. A rename in
 * place must not vouch for a move from elsewhere that lands beside it, so the
 * folder decision is made for the operations that bring a file INTO the
 * folder, and `decisionForDestination` grants the in-place renames on their
 * own when given the operation's source.
 * @param {Array<{ source?: string, destination?: string }>} operations
 * @param {PolicyDeps} [deps]
 * @returns {Promise<Map<string, DestinationDecision>>} keyed by `dirKey(dirname(destination))`
 */
async function authorizeDestinations(operations, deps = {}) {
  const platform = deps.platform || process.platform;
  const p = pathFor(platform);
  /**
   * @type {Map<string, {
   *   destination: string,
   *   sameFolderSource: string|null,
   *   crossFolder: number,
   *   count: number
   * }>}
   */
  const byFolder = new Map();
  for (const op of Array.isArray(operations) ? operations : []) {
    if (typeof op?.destination !== 'string' || !op.destination.trim()) continue;
    const key = dirKey(p.dirname(p.resolve(op.destination)), platform);
    const source = typeof op.source === 'string' && op.source ? op.source : null;
    const inPlace = isSameFolder(source, key, platform);
    let entry = byFolder.get(key);
    if (!entry) {
      entry = { destination: op.destination, sameFolderSource: null, crossFolder: 0, count: 0 };
      byFolder.set(key, entry);
    }
    entry.count += 1;
    if (inPlace) {
      if (entry.sameFolderSource === null) entry.sameFolderSource = source;
    } else {
      // The dialog names what is being brought in, so the first cross-folder
      // destination is the one shown and in-place renames are not counted.
      if (entry.crossFolder === 0) entry.destination = op.destination;
      entry.crossFolder += 1;
    }
  }
  /** @type {Map<string, DestinationDecision>} */
  const decisions = new Map();
  for (const [key, entry] of byFolder) {
    const sourcePath = entry.crossFolder === 0 ? entry.sameFolderSource : null;
    decisions.set(
      key,
      await authorizeDestination(entry.destination, {
        ...deps,
        sourcePath,
        intent: {
          count: entry.crossFolder === 0 ? entry.count : entry.crossFolder,
          name: p.basename(entry.destination)
        }
      })
    );
  }
  return decisions;
}

/**
 * @param {string|null|undefined} sourcePath
 * @param {string} destDirKey  `dirKey` of the destination's folder
 * @param {string} platform
 */
function isSameFolder(sourcePath, destDirKey, platform) {
  if (typeof sourcePath !== 'string' || !sourcePath) return false;
  const p = pathFor(platform);
  return dirKey(p.dirname(p.resolve(sourcePath)), platform) === destDirKey;
}

/**
 * Look up the folder decision for one operation. When the folder itself was
 * not approved (a declined dialog, a network share) but this operation stays
 * in its own folder, it is allowed as an in-place rename, exactly as
 * `authorizeDestination` would decide it alone. Autostart folders and a
 * missing destination are refused for every operation.
 * @param {Map<string, DestinationDecision>|null|undefined} decisions
 * @param {string|null|undefined} destination
 * @param {string} [platform]
 * @param {string|null} [sourcePath]  the operation's source, for the per-op same-folder check
 * @returns {DestinationDecision|undefined}
 */
function decisionForDestination(
  decisions,
  destination,
  platform = process.platform,
  sourcePath = null
) {
  if (!decisions || typeof destination !== 'string' || !destination) return undefined;
  const p = pathFor(platform);
  const key = dirKey(p.dirname(p.resolve(destination)), platform);
  const folderDecision = decisions.get(key);
  if (!folderDecision || folderDecision.allowed) return folderDecision;
  if (folderDecision.reason === 'autostart' || folderDecision.reason === 'missing') {
    return folderDecision;
  }
  if (isSameFolder(sourcePath, key, platform)) return { allowed: true, reason: 'same-folder' };
  return folderDecision;
}

/** Clear session approvals (tests). */
function _resetDestinationPolicyForTests() {
  _approvedDirs.clear();
  _pendingPrompts.clear();
}

module.exports = {
  DESTINATION_ERROR_CODES,
  authorizeDestination,
  authorizeDestinations,
  authorizeSmartFolderRoot,
  isUserChosenLocation,
  decisionForDestination,
  rememberUserChosenLocation,
  getAllowedDestinationRoots,
  getAutostartLocations,
  isAutostartLocation,
  buildStrictFileOpsAllowlist,
  _resetDestinationPolicyForTests
};
