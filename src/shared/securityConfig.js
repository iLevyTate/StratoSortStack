// @ts-check
/**
 * Centralized Security Configuration
 *
 * This file consolidates all security-related constants and configurations
 * that were previously hard-coded across multiple files.
 *
 * Centralizing these allows for:
 * - Easier updates without code changes across multiple files
 * - Consistent security policies across the application
 * - Potential future support for environment-based overrides
 */

// Avoid pulling Node-only deps (e.g., child_process) into the renderer bundle.
// We only need the platform string here, so read it directly from process.
const PLATFORM = typeof process !== 'undefined' && process.platform ? process.platform : 'browser';

// Import shared validation constants
const {
  LOGGING_LEVELS,
  NUMERIC_LIMITS,
  URL_PATTERN,
  MODEL_NAME_PATTERN
} = require('./validationConstants');

const {
  MAX_PATH_LENGTHS,
  WIN32_LEGACY_MAX_PATH,
  isWindowsLongPathEnabled,
  getEffectiveMaxPathLength
} = require('./securityConfigPathLimits');

/**
 * Maximum path depth to prevent deep nesting attacks
 */
const MAX_PATH_DEPTH = 100;

/**
 * Reserved Windows filenames (case-insensitive)
 * These names cannot be used as file/folder names on Windows
 */
const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

/**
 * System directories that should never be accessed
 * These paths represent sensitive system areas that could be dangerous to modify
 */
const DANGEROUS_PATHS = {
  // Unix/Linux system directories
  unix: ['/etc', '/sys', '/proc', '/dev', '/boot', '/sbin', '/bin', '/usr/sbin'],
  // Windows system directories
  windows: [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\System Volume Information',
    'C:\\Users\\All Users',
    'C:\\Boot',
    'C:\\Recovery'
  ],
  // macOS system directories
  darwin: ['/System', '/Library/System', '/private/etc', '/private/var', '/Library/Preferences']
};

/**
 * Get dangerous paths for the current platform
 * @param {string} [platform] - Platform override (defaults to PLATFORM from crossPlatformUtils)
 * @returns {string[]} Array of dangerous paths for the platform
 */
// Cache dangerous paths per platform (platform doesn't change at runtime)
const _dangerousPathsCache = new Map();

function getDangerousPaths(platform = PLATFORM) {
  const cached = _dangerousPathsCache.get(platform);
  if (cached) return cached;

  const paths = [];

  // Add common Unix paths for darwin and linux
  if (platform === 'darwin' || platform === 'linux') {
    paths.push(...DANGEROUS_PATHS.unix);
  }

  // Add platform-specific paths
  if (platform === 'darwin') {
    paths.push(...DANGEROUS_PATHS.darwin);
  } else if (platform === 'win32') {
    // not just the hardcoded C: drive. Systems commonly have D:, E:, etc.
    const driveLetters = _getWindowsDriveLetters();
    const windowsSubPaths = [
      'Windows',
      'Program Files',
      'Program Files (x86)',
      'ProgramData',
      'System Volume Information',
      'Users\\All Users',
      'Boot',
      'Recovery'
    ];
    for (const drive of driveLetters) {
      for (const sub of windowsSubPaths) {
        paths.push(`${drive}\\${sub}`);
      }
    }
  }

  Object.freeze(paths);
  _dangerousPathsCache.set(platform, paths);
  return paths;
}

/**
 * Get available Windows drive letters.
 * Uses environment variables for the primary and home drives, and always includes C:.
 * @private
 * @returns {string[]} Array of drive letter prefixes like ['C:', 'D:']
 */
function _getWindowsDriveLetters() {
  const drives = new Set();

  // Always include C: as a baseline
  drives.add('C:');

  if (typeof process !== 'undefined' && process.env) {
    // SYSTEMDRIVE is the OS installation drive (usually C:)
    const systemDrive = process.env.SYSTEMDRIVE;
    if (systemDrive) {
      drives.add(systemDrive.toUpperCase().replace(/\\$/, ''));
    }
    // HOMEDRIVE can differ from SYSTEMDRIVE on domain-joined machines
    const homeDrive = process.env.HOMEDRIVE;
    if (homeDrive) {
      drives.add(homeDrive.toUpperCase().replace(/\\$/, ''));
    }
  }

  return Array.from(drives);
}

/**
 * Keys that should never appear in user-provided objects (prototype pollution prevention)
 */
const PROTOTYPE_POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Allowed Electron app paths for file operations
 * Used to determine what user directories are safe to access
 */
const ALLOWED_APP_PATHS = [
  'userData', // App data directory
  'documents', // User documents
  'downloads', // Downloads
  'desktop', // Desktop
  'pictures', // Pictures
  'videos', // Videos
  'music', // Music
  'home' // Home directory
];

/**
 * Settings validation configuration
 */
const SETTINGS_VALIDATION = {
  // Keys that can be modified through the settings API.
  // `settingsSchemaVersion` is included so the migration metadata round-
  // trips through allowlisted sanitization (defaultSettings seeds it,
  // SettingsMigrator rewrites it). Previously it was silently stripped by
  // the allowlist, meaning a settings save after migration wrote the
  // previous version back and the next boot re-ran the full migration
  // chain unnecessarily.
  allowedKeys: new Set([
    'settingsSchemaVersion',
    'textModel',
    'visionModel',
    'embeddingModel',
    // First-run consent: user chose "Continue with limited AI" — background
    // setup must not auto-download models until an explicit download clears it.
    'modelAutoDownloadSkipped',
    // Embedding workflow controls
    'embeddingTiming',
    'defaultEmbeddingPolicy',
    'embeddingScope',
    // LLM engine settings
    'llamaGpuLayers',
    'llamaContextSize',
    'vectorDbPersistPath',
    // AI provider configuration blob (providers/routing/consent). Deeply
    // validated by the AI provider subsystem; allowlisted so import/round-trip
    // preserves it instead of stripping the user's provider setup.
    'ai',
    // Chat settings
    'chatPersona',
    'chatPersonaCustomGuidance',
    'customChatPersonas',
    'chatResponseMode',
    // Organization
    'organizationCustomGuidance',
    'launchOnStartup',
    'autoOrganize',
    'backgroundMode',
    'loggingLevel',
    'autoUpdateCheck',
    // UI settings
    'experienceMode',
    'notifications',
    'notificationMode',
    'notifyOnAutoAnalysis',
    'notifyOnLowConfidence',
    'defaultSmartFolderLocation',
    'lastBrowsedPath',
    'confidenceThreshold',
    'smartFolderRoutingMode',
    // Naming convention settings
    'namingConvention',
    'dateFormat',
    'caseConvention',
    'separator',
    // Processing limits
    'autoConcurrency',
    'maxConcurrentAnalysis',
    'maxImageFileSize',
    'maxDocumentFileSize',
    'maxTextFileSize',
    // Semantic search settings
    'developerGraphEnabled',
    'autoChunkOnAnalysis', // Opt-in: generate chunk embeddings during file analysis
    'graphExpansionEnabled',
    'graphExpansionWeight',
    'graphExpansionMaxNeighbors',
    'chunkContextEnabled',
    'chunkContextMaxNeighbors',
    // Downloads Triage user exclusion globs (Phase 3)
    'downloadsTriageExclusions',
    // UI limits
    'workflowRestoreMaxAge',
    'saveDebounceMs',
    // Live opt-out for smart-folder watching (Settings → Auto-organize)
    'smartFolderWatchEnabled',
    // Vision captions for video keyframes (Settings → Processing limits)
    'captionVideoKeyframes',
    // Advanced-mode values parked while Simple mode is on (internal-only)
    'advancedModeValues'
  ]),

  // Valid values for enum fields (from shared validationConstants)
  enums: {
    loggingLevel: LOGGING_LEVELS
  },

  // Numeric field constraints (from shared validationConstants)
  numericLimits: NUMERIC_LIMITS,

  // Regex patterns for string validation (from shared validationConstants)
  patterns: {
    url: URL_PATTERN,
    modelName: MODEL_NAME_PATTERN
  }
};

/**
 * Allowed metadata fields for file operations
 */
const ALLOWED_METADATA_FIELDS = [
  'path',
  'name',
  'model',
  'updatedAt',
  'description',
  'summary',
  'fileSize',
  'mimeType',
  'fileExtension',
  'category',
  'type',
  'tags',
  'keywords',
  'entity',
  // 'type',
  'project',
  'date',
  'suggestedName',
  'purpose',
  'content_type',
  'contentType',
  'colors',
  'has_text',
  'subject',
  'confidence',
  // Extended fields for document conversations
  'documentType',
  'extractedText',
  'extractionMethod',
  'keyEntities',
  'dates',
  'reasoning'
];

/**
 * IPC receive channels that are safe to expose to renderer.
 * Uses centralized IPC_EVENTS from constants.js plus the vectordb:status-changed
 * channel from IPC_CHANNELS (which doubles as both an invoke and event channel).
 */
const { IPC_CHANNELS, IPC_EVENTS } = require('./constants');

const ALLOWED_RECEIVE_CHANNELS = [
  IPC_EVENTS.SYSTEM_METRICS,
  IPC_EVENTS.OPERATION_PROGRESS,
  IPC_EVENTS.APP_ERROR,
  IPC_EVENTS.APP_UPDATE,
  IPC_EVENTS.MENU_ACTION,
  IPC_EVENTS.OPEN_SEMANTIC_SEARCH,
  IPC_EVENTS.SETTINGS_CHANGED_EXTERNAL,
  IPC_EVENTS.FILE_OPERATION_COMPLETE,
  IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED,
  IPC_EVENTS.NOTIFICATION,
  // notification-action carries native-notification click activations
  // (NotificationService -> onNotificationAction -> deep-link navigation).
  // It shipped without this entry (PR #332), so safeOn() no-opped the
  // listener and notification clicks never navigated the app (F-077).
  IPC_EVENTS.NOTIFICATION_ACTION,
  // smart-folders-updated signals main-process-initiated folder mutations
  // (background LLM enhancement after smart-folders:add) so an open renderer
  // refreshes instead of showing the pre-enhancement folder until remount.
  IPC_EVENTS.SMART_FOLDERS_UPDATED,
  IPC_CHANNELS.UNDO_REDO.STATE_CHANGED,
  IPC_EVENTS.BATCH_RESULTS_CHUNK,
  // Per-file batch-analysis completion stream (Discover phase live updates).
  IPC_EVENTS.ANALYSIS_FILE_COMPLETE,
  IPC_CHANNELS.CHAT.STREAM_CHUNK,
  IPC_CHANNELS.CHAT.STREAM_END,
  IPC_CHANNELS.DOWNLOADS?.TRIAGE_SCAN_PROGRESS,
  IPC_CHANNELS.DOWNLOADS?.TRIAGE_SESSION_INVALIDATED,
  // Status events for the new multi-provider AI router and MCP server.
  // Without these, secureIPC.safeOn() blocks subscribers and the renderer
  // never receives provider/server status changes — the preload bridges
  // were workaround-using raw ipcRenderer.on, which bypassed listener
  // tracking and the channel allowlist.
  IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED,
  IPC_CHANNELS.MCP?.STATUS_CHANGED
].filter(Boolean);

/**
 * IPC send channels that renderer can use
 */
const ALLOWED_SEND_CHANNELS = ['renderer-error-report'];

/**
 * Executable / auto-run file extensions that must never be passed to
 * `shell.openPath` or `shell.openExternal`. Opening any of these would
 * hand the OS a command to execute — even when the path itself passes
 * standard sanitization (it's inside the user's Documents folder, etc.).
 *
 * This list is intentionally broad and platform-agnostic: an `.exe` inside
 * a macOS app bundle is still dangerous if the user ever copies it to a
 * Windows machine. The handful of false positives (legitimate `.jar`
 * archives, `.app` directory contents on macOS) are acceptable because
 * reveal-in-folder is always available as a fallback for the user.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.psd1',
  '.vbs',
  '.vbe',
  '.js', // WSH interprets .js outside a browser context
  '.jse',
  '.wsf',
  '.wsh',
  '.ws', // Windows Script file (WSH)
  '.msi',
  '.msp',
  '.mst', // Windows Installer Transform — applied alongside .msi
  '.scr',
  '.cpl',
  '.reg',
  '.hta',
  '.inf',
  '.lnk', // Shortcut — can target arbitrary commands
  '.pif',
  '.url', // Shell URL handler file
  '.scf',
  '.msc', // Management Console snap-in — loads arbitrary DLLs/tasks
  '.chm', // Compiled HTML Help — embedded script/ActiveX
  '.appref-ms', // ClickOnce application reference — downloads and runs an app
  '.settingcontent-ms', // Settings shortcut — DeepLink runs arbitrary commands
  '.library-ms', // Library definition — can point at remote/WebDAV locations
  '.searchconnector-ms', // Search connector — remote location, same surface as .library-ms
  '.diagcab', // Troubleshooting pack — runs PowerShell via msdt
  '.scpt',
  '.jar',
  '.appx',
  '.appxbundle',
  '.msix',
  '.msixbundle',
  '.gadget', // Windows Desktop Gadget — runs arbitrary script
  '.application', // ClickOnce deployment manifest: installs and runs an app
  '.xll', // Excel add-in: native code loaded by Excel
  '.msu', // Windows Update package: runs the standalone installer
  '.wsc', // Windows Script Component
  '.sct', // Scriptlet: regsvr32 runs the embedded script
  '.website', // Pinned-site shortcut, same surface as .url
  '.jnlp', // Java Web Start launch file
  // Disk images — Windows auto-mounts on open, exposing the volume's autorun surface
  '.iso',
  '.img',
  '.vhd',
  '.vhdx',
  // macOS
  '.app', // App bundle
  '.pkg',
  '.dmg',
  '.command',
  '.terminal',
  '.workflow',
  '.action',
  // Unix/Linux
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.csh',
  '.ksh',
  '.py', // Only when marked executable, but we deny uniformly
  '.pyc',
  '.pyo',
  '.pyw',
  '.pyz', // Python zip application
  '.pyzw',
  '.rb',
  '.pl',
  '.php',
  '.phar',
  '.desktop', // Freedesktop launcher — can exec arbitrary commands
  '.appimage',
  '.run',
  '.bin'
]);

/**
 * Returns true if the given path ends in an extension that must not be
 * opened via the OS shell. Input is expected to be a normalized file path
 * or basename; matching is case-insensitive. Trailing dots and spaces are
 * ignored because Windows strips them before resolving the file, so
 * `evil.exe.` and `evil.exe ` both launch `evil.exe`.
 * @param {string} filePath
 */
function isExecutableExtension(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  // Extract the final extension. We don't split on dot for compound names like
  // ".tar.gz" because those aren't executable anyway.
  const lowered = filePath.toLowerCase();
  const lastSlash = Math.max(lowered.lastIndexOf('/'), lowered.lastIndexOf('\\'));
  const basename = (lastSlash >= 0 ? lowered.slice(lastSlash + 1) : lowered).replace(/[. ]+$/, '');
  const lastDot = basename.lastIndexOf('.');
  if (lastDot <= 0) return false; // No extension, or dotfile with no ext
  const ext = basename.slice(lastDot);
  return EXECUTABLE_EXTENSIONS.has(ext);
}

module.exports = {
  // Path security
  MAX_PATH_LENGTHS,
  MAX_PATH_DEPTH,
  WIN32_LEGACY_MAX_PATH,
  isWindowsLongPathEnabled,
  getEffectiveMaxPathLength,
  RESERVED_WINDOWS_NAMES,
  DANGEROUS_PATHS,
  getDangerousPaths,
  PROTOTYPE_POLLUTION_KEYS,
  ALLOWED_APP_PATHS,

  // Shell security
  EXECUTABLE_EXTENSIONS,
  isExecutableExtension,

  // Settings security
  SETTINGS_VALIDATION,
  ALLOWED_METADATA_FIELDS,

  // IPC security
  ALLOWED_RECEIVE_CHANNELS,
  ALLOWED_SEND_CHANNELS
};
