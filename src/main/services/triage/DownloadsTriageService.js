// @ts-check
/**
 * DownloadsTriageService — Phase 3 orchestrator.
 *
 * Two-tier sweep of a chosen folder (defaults to the OS Downloads dir):
 *
 *   - Tier 0 (metadata-only): runs immediately via FastTriageClassifier
 *     against every scanned entry, producing keep / trash / excluded /
 *     ambiguous buckets.
 *
 *   - Tier 1 (user-gated): on explicit deepScan() call, re-classifies the
 *     AMBIGUOUS subset using the existing embedding pipeline. Only the
 *     ambiguous remainder is re-embedded, so the user pays compute cost
 *     only for files that truly need it.
 *
 * State is held per-session in an in-memory Map so the renderer can round-trip
 * just a triageId between start() and deepScan() / act() rather than
 * re-shipping tens of MB of file lists. Sessions time out after 30 min and
 * are capped at 3 concurrent per process.
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { app } = require('electron');
const crypto = require('crypto');
const { createLogger } = require('../../../shared/logger');
const { FastTriageClassifier, BUCKET, SIGNAL } = require('./FastTriageClassifier');
const { container, ServiceIds } = require('../ServiceContainer');
const { loadCustomFolders } = require('../../core/customFolders');
const { scanDirectory } = require('../../folderScanner');
const { computeFileChecksum } = require('../../utils/fileDedup');
const { getHashCache } = require('../../utils/hashCache');
const {
  DEFAULT_EXCLUSION_GLOBS,
  sanitizeExclusionGlobs
} = require('../../../shared/config/exclusionRulesSchema');
const { THRESHOLDS, TIMEOUTS } = require('../../../shared/performanceConstants');
const { ACTION_TYPES } = require('../../../shared/constants');
const { validateFileOperationPath } = require('../../../shared/pathSanitization');
const { withTimeout } = require('../../../shared/promiseUtils');
const { isCaseInsensitiveFileSystem } = require('../../../shared/crossPlatformUtils');

const logger = createLogger('DownloadsTriageService');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT_SESSIONS = 3;

/**
 * Bounded parallelism for Tier 0 / Tier 1 per-file work (CPU + filesystem bound).
 * @returns {number}
 */
function getTier0ClassifyConcurrency() {
  const count = typeof os.cpus === 'function' ? os.cpus().length : 4;
  return Math.max(2, Math.min(Math.max(1, count) - 1, 12));
}

function generateTriageId() {
  return `triage-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Must stay aligned with `folderScanner.DEFAULT_IGNORE_PATTERNS` (used when tests mock the module). */
const FALLBACK_SCAN_DEFAULT_IGNORES = Object.freeze([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.git',
  'node_modules',
  '__pycache__'
]);

/**
 * folderScanner ignore defaults (tests may mock `scanDirectory` only — no `DEFAULT_IGNORE_PATTERNS` export).
 * @returns {string[]}
 */
function getFolderScannerDefaultIgnores() {
  try {
    const mod = require('../../folderScanner');
    if (Array.isArray(mod.DEFAULT_IGNORE_PATTERNS) && mod.DEFAULT_IGNORE_PATTERNS.length > 0) {
      return mod.DEFAULT_IGNORE_PATTERNS;
    }
  } catch {
    /* non-fatal */
  }
  return [...FALLBACK_SCAN_DEFAULT_IGNORES];
}

/**
 * Maps triage exclusion globs (minimatch in the classifier) onto folderScanner
 * ignore entries where semantics overlap: `*.ext`, plain basenames, and a
 * folder rule in either spelling (`archived/**`, `**\/archived/**`) → its
 * last literal segment, so large trees are not enumerated.
 *
 * @param {string[]} exclusionGlobs
 * @returns {string[]}
 */
function buildTriageScanIgnorePatterns(exclusionGlobs) {
  const out = new Set(getFolderScannerDefaultIgnores());
  for (const raw of exclusionGlobs || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const g = raw.trim();
    if (g.startsWith('*.')) {
      out.add(g);
      continue;
    }
    if (!/[*?[\]]/.test(g)) {
      out.add(g.includes('/') ? g.replace(/^.*[\\/]/, '') : g);
      continue;
    }
    const trail = g.match(/^(?:\*\*\/)?([^*?[\]]+)\/\*\*$/);
    if (trail && trail[1]) {
      const seg = trail[1].replace(/[\\/]+$/, '');
      const last = seg.includes('/') ? seg.replace(/^.*[\\/]/, '') : seg;
      if (last) out.add(last);
    }
  }
  return Array.from(out);
}

/**
 * Resolve modification time in ms from a folderScanner node (or similar).
 * Prefers explicit mtimeMs / stats.mtimeMs; falls back to ISO `modified` for callers that bypass the scanner.
 *
 * @param {any} node
 * @returns {number}
 */
function resolveMtimeMs(node) {
  if (!node || typeof node !== 'object') return 0;
  const fromField = Number(node.mtimeMs);
  if (Number.isFinite(fromField)) return fromField;
  const fromStats = Number(node.stats?.mtimeMs);
  if (Number.isFinite(fromStats)) return fromStats;
  if (typeof node.modified === 'string' && node.modified) {
    const parsed = Date.parse(node.modified);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Canonical path key for matching session rows to TrashService / validation output.
 * Mirrors `normalizePathForIndex` (NFC unicode + win32/darwin lowercase +
 * forward-slash separator) so scanner-recorded paths and paths canonicalized by
 * `validateFileOperationPath` (which can differ in case, NFC normalization, or
 * symlink resolution) collapse to the same key. Inlined rather than delegated
 * so `process.platform` mocks in tests still influence the result (the shared
 * helper caches platform at module load).
 *
 * @param {string} filePath
 * @returns {string}
 */
function triagePathKey(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  let normalized;
  try {
    normalized = path.normalize(filePath);
  } catch {
    normalized = filePath;
  }
  try {
    normalized = normalized.normalize('NFC');
  } catch {
    /* defensive: invalid surrogate */
  }
  if (isCaseInsensitiveFileSystem()) {
    normalized = normalized.toLowerCase();
  }
  return normalized.replace(/\\/g, '/');
}

function stripSessionPaths(/** @type {any} */ session, /** @type {any} */ pathKeys) {
  if (!session?.buckets || !pathKeys || pathKeys.size === 0) return;
  for (const bucketName of Object.keys(session.buckets)) {
    session.buckets[bucketName] = session.buckets[bucketName].filter(
      (/** @type {any} */ r) => !pathKeys.has(triagePathKey(r.filePath))
    );
  }
  for (const fp of [...session.classifications.keys()]) {
    if (pathKeys.has(triagePathKey(fp))) session.classifications.delete(fp);
  }
}

function tryResolveOrama() {
  return container.tryResolve(ServiceIds.ORAMA_VECTOR);
}

function tryResolveAnalysisHistory() {
  return container.tryResolve(ServiceIds.ANALYSIS_HISTORY);
}

function tryResolveFolderMatching() {
  return container.tryResolve(ServiceIds.FOLDER_MATCHING);
}

function tryResolveUndoRedo() {
  return container.tryResolve(ServiceIds.UNDO_REDO);
}

function tryResolveFilePathCoordinator() {
  return container.tryResolve(ServiceIds.FILE_PATH_COORDINATOR);
}

/**
 * @param {any} root
 * @param {string} child
 * @returns {boolean}
 */
function isPathEqualOrDescendantOfRoot(root, child) {
  if (typeof root !== 'string' || typeof child !== 'string' || !root || !child) {
    return false;
  }
  const r = path.normalize(path.resolve(root));
  const c = path.normalize(path.resolve(child));
  if (process.platform === 'win32') {
    const rl = r.toLowerCase();
    const cl = c.toLowerCase();
    return cl === rl || cl.startsWith(rl + path.sep);
  }
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Triage may only run under the OS Downloads directory and/or any Smart Folder root
 * (user-chosen), including subfolders.
 *
 * @param {string} resolvedFolder
 * @param {string} downloadsPath
 * @param {string[]} smartFolderAbsPaths
 * @returns {boolean}
 */
function isAllowedTriageScanRoot(resolvedFolder, downloadsPath, smartFolderAbsPaths) {
  const target = path.resolve(resolvedFolder);
  const candidates = [
    downloadsPath,
    ...(Array.isArray(smartFolderAbsPaths) ? smartFolderAbsPaths : [])
  ]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p));
  for (const root of candidates) {
    if (isPathEqualOrDescendantOfRoot(root, target)) {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort physical path for allowed-root comparison. Roots may legitimately
 * not exist yet (a Smart Folder that hasn't been created), so fall back to the
 * lexical resolution instead of failing.
 *
 * @param {string} p
 * @returns {Promise<string>}
 */
async function toRealPathBestEffort(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * @param {any} session
 * @returns {Set<string>} triagePathKey() values for all known file rows
 */
/**
 * Key -> {canonical path, record} lookup for a whole session, built ONCE per
 * act(). Replaces a per-file linear rescan of every classification + bucket
 * row (each recomputing NFC-folded keys) that made organize O(session×files).
 * Classifications win over bucket rows on key collisions, matching the old
 * scan order. The canonical `filePath` is what act() must operate on: the
 * membership match is by LOSSY key (NFC + case fold), so acting on the
 * renderer-supplied string would let a compromised renderer target a
 * key-colliding case/NFC-variant sibling that was never scanned.
 * @param {any} session
 * @returns {Map<string, { filePath: string, record: any }>}
 */
function buildSessionRecordMap(session) {
  /** @type {Map<string, { filePath: string, record: any }>} */
  const map = new Map();
  if (session?.classifications instanceof Map) {
    for (const [fp, rec] of session.classifications.entries()) {
      const k = triagePathKey(fp);
      if (k && !map.has(k)) map.set(k, { filePath: fp, record: rec });
    }
  }
  for (const bucketName of Object.keys(session?.buckets || {})) {
    const arr = session.buckets[bucketName];
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      const k = triagePathKey(r?.filePath);
      if (k && !map.has(k)) map.set(k, { filePath: r.filePath, record: r });
    }
  }
  return map;
}

class DownloadsTriageService {
  /**
   * @param {{ ttlMs?: number, maxConcurrent?: number }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, any>} */
    this._sessions = new Map();
    this._ttlMs = options.ttlMs || SESSION_TTL_MS;
    this._maxConcurrent = options.maxConcurrent || MAX_CONCURRENT_SESSIONS;
    /** @type {((ids: string[]) => void) | null} */
    this._onSessionsEvicted = null;
  }

  /**
   * Register a callback when sessions are removed (TTL expiry or concurrency cap).
   * Used by the main process to broadcast `TRIAGE_SESSION_INVALIDATED` to renderers.
   * @param {((ids: string[]) => void) | null} fn
   */
  setSessionEvictionBroadcaster(fn) {
    this._onSessionsEvicted = typeof fn === 'function' ? fn : null;
  }

  _notifySessionsEvicted(/** @type {any} */ ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (!this._onSessionsEvicted) return;
    try {
      this._onSessionsEvicted(ids);
    } catch (err) {
      logger.warn('[DownloadsTriageService] onSessionsEvicted failed', { error: err?.message });
    }
  }

  _evictExpiredSessions() {
    const now = Date.now();
    const evicted = [];
    for (const [id, session] of this._sessions) {
      if (now - session.createdAt > this._ttlMs) {
        evicted.push(id);
      }
    }
    for (const id of evicted) {
      this._sessions.delete(id);
    }
    this._notifySessionsEvicted(evicted);
  }

  _enforceConcurrencyCap() {
    const evicted = [];
    while (this._sessions.size >= this._maxConcurrent) {
      const oldestId = this._sessions.keys().next().value;
      if (!oldestId) break;
      this._sessions.delete(oldestId);
      evicted.push(oldestId);
    }
    this._notifySessionsEvicted(evicted);
  }

  _resolveFolderPath(/** @type {any} */ requested) {
    if (requested && typeof requested === 'string' && requested.trim()) {
      return path.resolve(requested.trim());
    }
    try {
      return app.getPath('downloads');
    } catch {
      return path.join(app.getPath('home'), 'Downloads');
    }
  }

  async _loadSmartFolders() {
    try {
      const folders = await loadCustomFolders();
      return Array.isArray(folders) ? folders : [];
    } catch (err) {
      logger.warn('[DownloadsTriageService] Failed to load smart folders', {
        error: err?.message
      });
      return [];
    }
  }

  _buildClassifier() {
    const orama = tryResolveOrama();
    const analysisHistory = tryResolveAnalysisHistory();
    const folderMatching = tryResolveFolderMatching();
    return new FastTriageClassifier({
      oramaService: orama,
      analysisHistory,
      folderMatchingService: folderMatching,
      hashCache: getHashCache(),
      computeFileChecksum
    });
  }

  /**
   * Tier 0 classification with bounded parallelism and optional AbortSignal.
   *
   * @param {Array<{filePath:string,fileName:string,size:number,mtimeMs:number}>} fileEntries
   * @param {*} classifier
   * @param {object} classifyCtx
   * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void }} [options]
   * @returns {Promise<{classifications:Map<any,any>,buckets:object}|{aborted:true}>}
   */
  async _runTier0Classification(fileEntries, classifier, classifyCtx, options = {}) {
    const { signal, onProgress } = options;
    const n = fileEntries.length;
    if (n === 0) {
      return {
        classifications: new Map(),
        buckets: { keep: [], trash: [], excluded: [], ambiguous: [] }
      };
    }
    if (signal?.aborted) {
      return { aborted: true };
    }

    const results = new Array(n);
    const concurrency = getTier0ClassifyConcurrency();
    let nextIndex = 0;
    let completed = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;

    const emitProgress = () => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      if (now - lastProgressAt < 200 && completed < n) return;
      lastProgressAt = now;
      const elapsedSec = (now - startedAt) / 1000;
      const rate = elapsedSec > 0 ? completed / elapsedSec : 0;
      const remaining = n - completed;
      const etaSeconds = rate > 0 ? remaining / rate : undefined;
      onProgress({
        phase: 'tier0',
        done: completed,
        total: n,
        rate,
        etaSeconds
      });
    };

    const runOne = async (/** @type {any} */ index) => {
      if (signal?.aborted) return;
      const entry = fileEntries[index];
      let result;
      try {
        result = await classifier.classifyFile(entry, classifyCtx);
      } catch (err) {
        logger.warn('[DownloadsTriageService] classifier threw', {
          filePath: entry.filePath,
          error: err?.message
        });
        result = {
          bucket: BUCKET.AMBIGUOUS,
          signal: SIGNAL.NO_MATCH,
          confidence: 0,
          why: `Classification failed: ${err?.message || 'unknown error'}`
        };
      }
      results[index] = result;
      completed += 1;
      emitProgress();
    };

    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const i = nextIndex++;
        if (i >= n) return;
        await runOne(i);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (signal?.aborted) {
      return { aborted: true };
    }

    /** @type {Map<any, any>} */
    const classifications = new Map();
    /** @type {Record<string, any[]>} */
    const buckets = { keep: [], trash: [], excluded: [], ambiguous: [] };
    for (let i = 0; i < n; i += 1) {
      const entry = fileEntries[i];
      const result = results[i];
      if (!result) {
        logger.warn('[DownloadsTriageService] Tier 0 missing classification slot', {
          filePath: entry?.filePath
        });
        const fallback = {
          bucket: BUCKET.AMBIGUOUS,
          signal: SIGNAL.NO_MATCH,
          confidence: 0,
          why: 'Classification incomplete (internal consistency)'
        };
        const record = { ...entry, ...fallback };
        classifications.set(entry.filePath, record);
        buckets.ambiguous.push(record);
        continue;
      }
      const record = {
        ...entry,
        ...result
      };
      classifications.set(entry.filePath, record);
      const targetBucket = buckets[result.bucket];
      if (!targetBucket) {
        // Defensive: classifier returned a bucket name we don't recognize.
        // Without this guard, `undefined.push(record)` would crash mid-loop
        // and lose the rest of the batch with a cryptic TypeError. Reroute
        // to ambiguous so the file still surfaces in the UI, and log loudly
        // so the unexpected bucket name is investigable.
        logger.error('[DownloadsTriageService] Unexpected classification bucket; rerouting', {
          bucket: result.bucket,
          filePath: entry.filePath,
          knownBuckets: Object.keys(buckets)
        });
        record.bucket = BUCKET.AMBIGUOUS;
        record.signal = SIGNAL.NO_MATCH;
        record.why = `Unknown bucket "${result.bucket}" (rerouted to ambiguous)`;
        buckets.ambiguous.push(record);
        continue;
      }
      targetBucket.push(record);
    }
    emitProgress();
    return { classifications, buckets };
  }

  /**
   * Start a triage session with Tier 0 classification.
   *
   * @param {Object} params
   * @param {string} [params.folderPath]
   * @param {number} [params.maxFiles=2000]
   * @param {number} [params.maxDepth=1]
   * @param {number} [params.minAgeHours=24]
   * @param {string[]} [params.exclusionGlobs] - user-supplied extras; merged with defaults
   * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void }} [execOptions]
   * @returns {Promise<Object>}
   */
  async start(params = {}, execOptions = {}) {
    this._evictExpiredSessions();
    this._enforceConcurrencyCap();

    const { signal, onProgress } = execOptions || {};

    const folderPath = this._resolveFolderPath(params.folderPath);
    const maxFiles = Number.isFinite(params.maxFiles) ? params.maxFiles : 2000;
    const maxDepth = Number.isFinite(params.maxDepth) ? params.maxDepth : 1;
    const minAgeMs = Math.max(0, Number(params.minAgeHours) || 24) * 60 * 60 * 1000;
    const userGlobs = sanitizeExclusionGlobs(params.exclusionGlobs) || [];
    const exclusionGlobs = Array.from(new Set([...DEFAULT_EXCLUSION_GLOBS, ...userGlobs]));

    // Verify the target folder exists; return a structured error rather than throw
    // so the renderer can show a clear message instead of a cryptic rejection.
    try {
      const stat = await fs.stat(folderPath);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: `${folderPath} is not a directory`,
          errorCode: 'NOT_DIRECTORY'
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `Cannot read folder: ${err?.message || String(err)}`,
        errorCode: err?.code || 'READ_FAILED',
        folderPath
      };
    }

    const smartFolders = await this._loadSmartFolders();
    const smartFolderPaths = smartFolders.map((f) => f?.path).filter(Boolean);

    let downloadsPath;
    try {
      downloadsPath = app.getPath('downloads');
    } catch {
      downloadsPath = path.join(app.getPath('home'), 'Downloads');
    }
    // The allowed-root check compares resolved paths lexically, but the chosen
    // folder may itself be a symlink/junction (e.g. a junction inside Downloads
    // pointing at Documents). Resolve physical paths on BOTH sides first —
    // otherwise scan and act(trash/organize) would operate on files that
    // physically live outside every allowed root. The walker already skips
    // symlinked children (folderScanner), so the root is the only escape hatch.
    let physicalFolderPath;
    try {
      physicalFolderPath = await fs.realpath(folderPath);
    } catch (err) {
      // stat() above succeeded, so this is an anomaly (folder vanished or an
      // unreadable reparse point) — fail closed rather than scan it.
      return {
        success: false,
        error: `Cannot read folder: ${err?.message || String(err)}`,
        errorCode: err?.code || 'READ_FAILED',
        folderPath
      };
    }
    const downloadsRealPath = await toRealPathBestEffort(downloadsPath);
    const smartFolderRealPaths = (
      await Promise.all(smartFolderPaths.map((p) => toRealPathBestEffort(p)))
    ).filter(Boolean);
    if (!isAllowedTriageScanRoot(physicalFolderPath, downloadsRealPath, smartFolderRealPaths)) {
      return {
        success: false,
        error: 'Choose a folder inside Downloads or a Smart Folder.',
        errorCode: 'FOLDER_NOT_ALLOWED',
        folderPath
      };
    }

    const classifier = this._buildClassifier();

    const scanResult = await scanDirectory(
      folderPath,
      buildTriageScanIgnorePatterns(exclusionGlobs),
      {
        includeStats: true,
        maxDepth,
        maxFiles
      }
    );
    const entries = Array.isArray(scanResult) ? scanResult : [];
    const _scanRes = /** @type {any} */ (scanResult);
    const scanMeta =
      Array.isArray(scanResult) && _scanRes.__scanMeta && typeof _scanRes.__scanMeta === 'object'
        ? { ..._scanRes.__scanMeta }
        : null;

    if (signal?.aborted) {
      return {
        success: false,
        canceled: true,
        cancelled: true,
        errorCode: 'ABORTED',
        buckets: { keep: [], trash: [], excluded: [], ambiguous: [] }
      };
    }

    /** @type {any[]} */
    const fileEntries = [];
    const walk = (/** @type {any} */ nodes) => {
      for (const node of nodes) {
        if (!node) continue;
        if (node.type === 'folder' || Array.isArray(node.children)) {
          if (Array.isArray(node.children)) walk(node.children);
          continue;
        }
        if (node.path) {
          fileEntries.push({
            filePath: node.path,
            fileName: node.name || path.basename(node.path),
            size: Number(node.size ?? node.stats?.size ?? 0),
            mtimeMs: resolveMtimeMs(node)
          });
        }
      }
    };
    walk(entries);

    const tier0 = await this._runTier0Classification(
      fileEntries,
      classifier,
      {
        smartFolders,
        smartFolderPaths,
        exclusionGlobs,
        // The swept folder: a relative folder rule (`archived/**`) reads
        // beneath it, never against its own ancestors.
        folderPath,
        minAgeMs
      },
      { signal, onProgress }
    );

    const _tier0 = /** @type {any} */ (tier0);
    if (_tier0.aborted) {
      return {
        success: false,
        canceled: true,
        cancelled: true,
        errorCode: 'ABORTED',
        buckets: { keep: [], trash: [], excluded: [], ambiguous: [] }
      };
    }

    const { classifications, buckets } = _tier0;

    const triageId = generateTriageId();
    this._sessions.set(triageId, {
      triageId,
      folderPath,
      smartFolders,
      smartFolderPaths,
      exclusionGlobs,
      minAgeMs,
      classifications,
      buckets,
      createdAt: Date.now(),
      /** Serialize act() per session so buckets / undo batches stay consistent. */
      actMutex: Promise.resolve()
    });

    logger.info('[DownloadsTriageService] Tier 0 scan complete', {
      triageId,
      folderPath,
      total: fileEntries.length,
      keep: buckets.keep.length,
      trash: buckets.trash.length,
      excluded: buckets.excluded.length,
      ambiguous: buckets.ambiguous.length
    });

    return {
      success: true,
      triageId,
      folderPath,
      total: fileEntries.length,
      buckets,
      scan: scanMeta
    };
  }

  /**
   * Tier 1 deep scan on the AMBIGUOUS subset of a session.
   * Re-classifies each ambiguous file by computing its embedding and matching
   * against folder embeddings. The session's buckets are updated in place and
   * the ambiguous entries move into keep / review / unmatched.
   *
   * @param {{ triageId?: string, fileIds?: string[] }} params
   * @param {{ signal?: AbortSignal, onProgress?: (p: object) => void }} [execOptions]
   */
  async deepScan(params = {}, execOptions = {}) {
    // Sweep stale sessions before each call. Without this, sessions evicted by
    // TTL but never replaced by a fresh start() linger in memory (their
    // classification Maps + bucket arrays) until the next start() call sweeps.
    this._evictExpiredSessions();

    const { triageId, fileIds } = params || {};
    const { signal, onProgress } = execOptions || {};

    const session = this._sessions.get(triageId);
    if (!session) {
      return { success: false, error: 'Triage session not found', errorCode: 'SESSION_NOT_FOUND' };
    }

    const folderMatching = tryResolveFolderMatching();
    if (!folderMatching || typeof folderMatching.embedText !== 'function') {
      return {
        success: false,
        error: 'Embedding service unavailable',
        errorCode: 'EMBED_UNAVAILABLE'
      };
    }

    if (!session.actMutex) {
      session.actMutex = Promise.resolve();
    }

    const runDeepScan = async () => {
      const orama = tryResolveOrama();
      const wantOnlyIds = Array.isArray(fileIds) && fileIds.length > 0 ? new Set(fileIds) : null;

      /** @type {any[]} */
      const remainingAmbiguous = [];
      /** @type {any[]} */
      const toProcess = [];
      for (const record of session.buckets.ambiguous) {
        if (wantOnlyIds && !wantOnlyIds.has(record.filePath)) {
          remainingAmbiguous.push(record);
          continue;
        }
        toProcess.push(record);
      }

      const { FOLDER_MATCH_CONFIDENCE } = THRESHOLDS;
      const REVIEW_MIN = 0.4;

      const nDeep = toProcess.length;
      const deepResults = new Array(nDeep);
      const cpuConcurrency = getTier0ClassifyConcurrency();
      // Match submission parallelism to the embedding service's actual capacity.
      // Without this, on low-VRAM hardware (concurrency=1) we'd submit 5–6 files
      // at once and ~5 of them would all queue with independent 5-min timers,
      // causing the cascading "Queue timeout" failures seen in the field.
      let embeddingConcurrency = null;
      try {
        const embeddingService = folderMatching._getEmbeddingService?.();
        const limit = embeddingService?.concurrencyLimit;
        if (Number.isFinite(limit) && limit > 0) {
          embeddingConcurrency = limit;
        }
      } catch {
        // Best-effort — fall back to CPU concurrency if introspection fails.
      }
      const concurrency =
        embeddingConcurrency != null
          ? Math.max(1, Math.min(cpuConcurrency, embeddingConcurrency))
          : cpuConcurrency;
      let nextDeep = 0;
      let completedDeep = 0;
      const deepStartedAt = Date.now();
      let lastDeepProgress = 0;

      const emitDeepProgress = () => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        if (now - lastDeepProgress < 200 && completedDeep < nDeep) return;
        lastDeepProgress = now;
        const elapsedSec = (now - deepStartedAt) / 1000;
        const rate = elapsedSec > 0 ? completedDeep / elapsedSec : 0;
        const remaining = nDeep - completedDeep;
        const etaSeconds = rate > 0 ? remaining / rate : undefined;
        onProgress({
          phase: 'tier1',
          triageId,
          done: completedDeep,
          total: nDeep,
          rate,
          etaSeconds
        });
      };

      const runDeepOne = async (/** @type {any} */ idx) => {
        if (signal?.aborted) return;
        const record = toProcess[idx];
        try {
          const textForEmbed = [
            record.fileName || '',
            path.extname(record.filePath || '').replace(/^\./, '')
          ]
            .filter(Boolean)
            .join(' ');
          const { vector } = await folderMatching.embedText(textForEmbed);
          const matches = await folderMatching.matchVectorToFolders(vector, 3);
          const top = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
          const score = Number(top?.confidence ?? top?.score ?? 0);

          let next;
          if (top && score >= FOLDER_MATCH_CONFIDENCE) {
            next = {
              ...record,
              bucket: BUCKET.KEEP,
              confidence: score,
              suggestedFolder: { id: top.id, name: top.name, path: top.path },
              signal: 'deep-embedding',
              why: `Deep scan matches "${top.name || top.id}" (${Math.round(score * 100)}%)`
            };
          } else if (top && score >= REVIEW_MIN) {
            next = {
              ...record,
              bucket: 'review',
              confidence: score,
              suggestedFolder: { id: top.id, name: top.name, path: top.path },
              signal: 'deep-embedding',
              why: `Possible match "${top.name || top.id}" (${Math.round(score * 100)}%) — review`
            };
          } else {
            next = {
              ...record,
              bucket: 'unmatched',
              confidence: score,
              signal: 'deep-embedding',
              why: 'No folder matched with sufficient confidence'
            };
          }
          deepResults[idx] = { ok: true, next };
        } catch (err) {
          // Distinguish embedding-queue saturation (recoverable, system-load related)
          // from real failures so the user-facing "why" message is actionable. The
          // QUEUE_TIMEOUT code is set by ParallelEmbeddingService when the slot wait
          // hits its timeout; FolderMatchingService.embedText wraps it as a
          // EMBEDDING_FAILED error whose message starts with "Embedding generation
          // failed: ParallelEmbeddingService: Queue timeout".
          const code = err?.originalError?.code || err?.code;
          const isQueueTimeout =
            code === 'QUEUE_TIMEOUT' || /queue timeout/i.test(err?.message || '');
          if (isQueueTimeout) {
            logger.warn('[DownloadsTriageService] deep scan deferred (embedding queue saturated)', {
              filePath: record.filePath
            });
          } else {
            logger.warn('[DownloadsTriageService] deep scan failed for file', {
              filePath: record.filePath,
              error: err?.message
            });
          }
          deepResults[idx] = { ok: false, record, err, queueTimeout: isQueueTimeout };
        }
        completedDeep += 1;
        emitDeepProgress();
      };

      const deepWorker = async () => {
        for (;;) {
          if (signal?.aborted) return;
          const i = nextDeep++;
          if (i >= nDeep) return;
          await runDeepOne(i);
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => deepWorker()));

      if (signal?.aborted) {
        return {
          success: false,
          canceled: true,
          cancelled: true,
          errorCode: 'ABORTED'
        };
      }

      const keep = [];
      const review = [];
      const unmatched = [];

      for (let i = 0; i < nDeep; i += 1) {
        const r = deepResults[i];
        if (!r) {
          const record = toProcess[i];
          if (record) {
            logger.warn('[DownloadsTriageService] Tier 1 missing deep-scan slot', {
              filePath: record.filePath
            });
            remainingAmbiguous.push({
              ...record,
              why: 'Deep scan incomplete (internal consistency)'
            });
          }
          continue;
        }
        if (!r.ok) {
          remainingAmbiguous.push({
            ...r.record,
            why: r.queueTimeout
              ? 'Deep scan deferred: AI engine is busy. Try again in a moment.'
              : `Deep scan failed: ${r.err?.message || 'unknown error'}`
          });
          continue;
        }
        const { next } = r;
        if (next.bucket === BUCKET.KEEP) keep.push(next);
        else if (next.bucket === 'review') review.push(next);
        else if (next.bucket === 'unmatched') unmatched.push(next);
        session.classifications.set(next.filePath, next);
      }

      // Merge new keep entries into session state so subsequent act() calls
      // see consistent membership.
      session.buckets.keep = session.buckets.keep.concat(keep);
      session.buckets.review = (session.buckets.review || []).concat(review);
      session.buckets.unmatched = (session.buckets.unmatched || []).concat(unmatched);
      session.buckets.ambiguous = remainingAmbiguous;

      logger.info('[DownloadsTriageService] Tier 1 deep scan complete', {
        triageId,
        reclassified: keep.length + review.length + unmatched.length,
        remainingAmbiguous: remainingAmbiguous.length,
        keep: keep.length,
        review: review.length,
        unmatched: unmatched.length
      });

      // Keep `orama` reference alive so linters don't flag unused — currently
      // unused here but kept available for future enrichment (not all code
      // paths below reach it).
      void orama;

      return {
        success: true,
        triageId,
        buckets: session.buckets
      };
    };

    return this._withSessionActMutex(session, runDeepScan);
  }

  /**
   * Promise-based mutex for a single triage session's act(), deepScan, etc.
   * @param {any} session
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async _withSessionActMutex(session, fn) {
    const prev = session.actMutex || Promise.resolve();
    /** @type {(v?: any) => void} */
    let resolve = () => {};
    session.actMutex = new Promise((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  /**
   * Act on classified files: trash, organize, or ignore.
   * Trash action routes through TrashService + one batched Undo entry so the
   * whole operation is a single Ctrl-Z.
   */
  async act(
    /** @type {{ triageId?: any, action?: any, files?: any, summary?: any }} */ {
      triageId,
      action,
      files,
      summary
    } = {}
  ) {
    // Sweep stale sessions on entry — same rationale as deepScan().
    this._evictExpiredSessions();

    if (!Array.isArray(files) || files.length === 0) {
      return { success: false, error: 'No files provided' };
    }

    const allowed = new Set(['trash', 'organize', 'ignore']);
    if (!allowed.has(action)) {
      return { success: false, error: `Unknown action: ${action}`, errorCode: 'UNKNOWN_ACTION' };
    }

    const session = this._sessions.get(triageId);
    if (!session) {
      return {
        success: false,
        error: 'Unknown triage session',
        errorCode: 'NO_SESSION'
      };
    }

    if (!session.actMutex) {
      session.actMutex = Promise.resolve();
    }

    return this._withSessionActMutex(session, async () => {
      const recordMap = buildSessionRecordMap(session);
      // Substitute the session-canonical path for the renderer's string on a
      // key match (see buildSessionRecordMap) — everything downstream (trash,
      // organize, undo records) operates on paths this session actually
      // scanned.
      const filesInSession = files
        .filter((f) => f && recordMap.has(triagePathKey(f.path)))
        .map((f) => ({ ...f, path: recordMap.get(triagePathKey(f.path)).filePath }));
      const rejectedNotInSession = files
        .filter((f) => f && !recordMap.has(triagePathKey(f.path)))
        .map((f) => ({ path: f.path, error: 'not_in_triage_session' }));
      if (filesInSession.length === 0) {
        return {
          success: false,
          error: 'No file paths belong to this triage session',
          errorCode: 'NOT_IN_SESSION',
          rejected: rejectedNotInSession
        };
      }

      if (action === 'trash') {
        const { TrashService } = require('../TrashService');
        const trasher = new TrashService();
        const paths = filesInSession.map((f) => f.path).filter(Boolean);
        const result = await trasher.trashBatch(paths);

        // Track whether undo recording succeeded so we can surface "undo
        // unavailable" to the renderer instead of silently leaving the user
        // with no way to recover from a successful trash that the undo
        // history doesn't know about.
        let undoUnavailable = false;
        let undoError;
        if (result.trashed.length > 0) {
          const undo = tryResolveUndoRedo();
          if (undo && typeof undo.recordBatch === 'function') {
            const operations = result.trashed.map((item) => ({
              type: 'trash',
              originalPath: item.path,
              size: item.size || 0
            }));
            try {
              await undo.recordBatch(ACTION_TYPES.TRASH_BATCH, operations, {
                summary: summary || { label: 'Downloads triage — Send to Trash' }
              });
            } catch (err) {
              undoUnavailable = true;
              undoError = err?.message || String(err);
              logger.warn('[DownloadsTriageService] TRASH_BATCH undo record failed', {
                error: undoError
              });
            }
          } else {
            undoUnavailable = true;
            undoError = 'Undo system unavailable';
          }
          // A trashed file is a deletion for every index (vector row,
          // analysis history, embedding queue, processing state), then one
          // BM25 rebuild; the vector row alone left the file in history,
          // keyword search and the Atlas.
          const coordinator = container.tryResolve(ServiceIds.FILE_PATH_COORDINATOR);
          const orama = tryResolveOrama();
          for (const item of result.trashed) {
            try {
              if (coordinator?.handleFileDeletion) {
                await coordinator.handleFileDeletion(item.path);
              } else if (orama?.deleteFileByPath) {
                await orama.deleteFileByPath(item.path);
              }
            } catch (err) {
              logger.debug('[DownloadsTriageService] index cleanup failed', {
                path: item.path,
                error: err?.message
              });
            }
          }
          if (result.trashed.length > 0) {
            try {
              container
                .tryResolve(ServiceIds.SEARCH_SERVICE)
                ?.invalidateAndRebuild?.({ immediate: false, reason: 'triage-trash' })
                ?.catch?.(() => {});
            } catch {
              // Best effort.
            }
          }
        }

        // Remove trashed files from the session buckets so the UI reflects
        // reality on the next view render. Only drop paths the OS actually trashed.
        const trashedKeys = new Set(
          result.trashed.map((t) => triagePathKey(t.path)).filter(Boolean)
        );
        stripSessionPaths(session, trashedKeys);

        return {
          success: result.failed.length === 0,
          action,
          trashed: result.trashed,
          failed: result.failed,
          totalBytes: result.totalBytes,
          ...(rejectedNotInSession.length > 0 ? { rejected: rejectedNotInSession } : {}),
          ...(undoUnavailable ? { undoUnavailable: true, undoError } : {})
        };
      }

      if (action === 'ignore') {
        // "Ignore for 30 days" is a UX affordance; from the backend perspective,
        // we just drop the files from the session so they disappear from view.
        const ignoreKeys = new Set(
          filesInSession.map((f) => triagePathKey(f.path)).filter(Boolean)
        );
        stripSessionPaths(session, ignoreKeys);
        return {
          success: true,
          action,
          ignored: filesInSession.length,
          ...(rejectedNotInSession.length > 0 ? { rejected: rejectedNotInSession } : {})
        };
      }

      if (action === 'organize') {
        const {
          performFileMove,
          computeFileChecksum
        } = require('../../ipc/files/batchOrganizeHandler');
        const moved = [];
        const failed = [];
        let totalBytes = 0;
        const undoOps = [];

        // Fail closed on destination containment: suggestions only ever come
        // from this session's Smart Folder records, so a destination outside
        // every session root (scanned folder + Smart Folders) means corrupted
        // session state or a regressed classifier. Prefer a per-file no-op
        // over a move outside the triage boundary.
        const allowedDestRoots = [session.folderPath, ...(session.smartFolderPaths || [])]
          .filter((p) => typeof p === 'string' && p.length > 0)
          .map((p) => path.resolve(p));

        for (const f of filesInSession) {
          const srcRaw = f?.path;
          const destDirRaw = f?.suggestedFolderPath;
          if (!srcRaw || typeof srcRaw !== 'string') {
            failed.push({ path: srcRaw, error: 'Invalid source path' });
            continue;
          }
          if (!destDirRaw || typeof destDirRaw !== 'string') {
            failed.push({ path: srcRaw, error: 'Missing suggested folder path' });
            continue;
          }

          const rec = /** @type {any} */ (recordMap.get(triagePathKey(srcRaw))?.record);
          const expectedDir = rec?.suggestedFolder?.path;
          if (!expectedDir || typeof expectedDir !== 'string') {
            failed.push({
              path: srcRaw,
              error: 'No suggested folder in session for this file'
            });
            continue;
          }
          if (triagePathKey(destDirRaw) !== triagePathKey(expectedDir)) {
            failed.push({
              path: srcRaw,
              error: 'Destination does not match triage suggestion'
            });
            continue;
          }

          const destDirValidation = await validateFileOperationPath(destDirRaw, {
            checkSymlinks: false
          });
          if (!destDirValidation.valid) {
            failed.push({
              path: srcRaw,
              error: destDirValidation.error || 'Invalid destination directory'
            });
            continue;
          }

          const destDirContained = allowedDestRoots.some((root) =>
            isPathEqualOrDescendantOfRoot(root, destDirValidation.normalizedPath)
          );
          if (!destDirContained) {
            failed.push({
              path: srcRaw,
              error: 'Destination outside the session triage roots'
            });
            continue;
          }

          const op = {
            source: srcRaw,
            destination: path.join(destDirValidation.normalizedPath, path.basename(srcRaw))
          };

          try {
            const sourceValidation = await validateFileOperationPath(op.source, {
              checkSymlinks: true
            });
            if (!sourceValidation.valid) {
              throw new Error(sourceValidation.error || 'Invalid source path');
            }
            const destValidation = await validateFileOperationPath(op.destination, {
              checkSymlinks: false
            });
            if (!destValidation.valid) {
              throw new Error(destValidation.error || 'Invalid destination path');
            }
            op.source = sourceValidation.normalizedPath;
            op.destination = destValidation.normalizedPath;

            await fs.mkdir(path.dirname(op.destination), { recursive: true });

            const moveResult = await withTimeout(
              performFileMove(op, logger, computeFileChecksum),
              TIMEOUTS.FILE_COPY || 120000,
              `Triage organize ${path.basename(op.source)}`
            );
            const finalDest = moveResult?.destination || op.destination;
            const size = Number(f.size) || 0;
            totalBytes += size;
            moved.push({ path: op.source, destination: finalDest, size });
            if (moveResult?.skipped) {
              // Dedup-skip: an identical file already sat at the destination,
              // so the SOURCE was removed and `finalDest` is the surviving
              // sibling this operation never touched. Recording a move undo
              // here made "undo" relocate that untouched sibling out of its
              // home. The source content is not restorable (it was
              // deduplicated away), so no undo op is recorded for this file.
            } else {
              undoOps.push({
                type: 'move',
                originalPath: op.source,
                newPath: finalDest
              });
            }
          } catch (err) {
            logger.warn('[DownloadsTriageService] organize move failed', {
              source: op.source,
              destination: op.destination,
              error: err?.message
            });
            failed.push({ path: op.source, error: err?.message || String(err) });
          }
        }

        // Same surfacing as the trash path: if undo recording fails after a
        // successful move, callers need to know so they can warn the user
        // (the move is permanent until the user manually moves files back).
        let moveUndoUnavailable = false;
        let moveUndoError;
        if (undoOps.length > 0) {
          const undo = tryResolveUndoRedo();
          if (undo && typeof undo.recordBatch === 'function') {
            try {
              await undo.recordBatch(ACTION_TYPES.MOVE_BATCH, undoOps, {
                summary: summary || { label: 'Downloads triage — Organize' }
              });
            } catch (err) {
              moveUndoUnavailable = true;
              moveUndoError = err?.message || String(err);
              logger.warn('[DownloadsTriageService] MOVE_BATCH undo record failed', {
                error: moveUndoError
              });
            }
          } else {
            moveUndoUnavailable = true;
            moveUndoError = 'Undo system unavailable';
          }

          const coordinator = tryResolveFilePathCoordinator();
          if (coordinator && typeof coordinator.batchPathUpdate === 'function') {
            const pathChanges = moved.map((m) => ({ oldPath: m.path, newPath: m.destination }));
            try {
              await coordinator.batchPathUpdate(pathChanges, { type: 'move' });
            } catch (err) {
              logger.warn('[DownloadsTriageService] batchPathUpdate after organize failed', {
                error: err?.message
              });
            }
          }
        }

        const movedKeys = new Set(moved.map((m) => triagePathKey(m.path)).filter(Boolean));
        stripSessionPaths(session, movedKeys);

        return {
          success: failed.length === 0,
          action,
          moved,
          failed,
          totalBytes,
          ...(rejectedNotInSession.length > 0 ? { rejected: rejectedNotInSession } : {}),
          ...(moveUndoUnavailable ? { undoUnavailable: true, undoError: moveUndoError } : {})
        };
      }

      return { success: false, error: `Unknown action: ${action}`, errorCode: 'UNKNOWN_ACTION' };
    });
  }

  /**
   * Helper for tests: retrieve a session by id (read-only view).
   */
  _getSession(/** @type {any} */ triageId) {
    return this._sessions.get(triageId) || null;
  }

  /**
   * Flat report rows for a live session (null if expired/unknown).
   * @param {string} triageId
   * @returns {Array<Record<string, string|number>>|null}
   */
  getReportRows(triageId) {
    // Same expiry semantics as start/deepScan/act: an export 30+ minutes
    // after the scan should say "session expired", not silently succeed.
    this._evictExpiredSessions();
    const session = this._getSession(triageId);
    if (!session) return null;
    const { buildReportRows } = require('./triageReport');
    return buildReportRows(session.buckets);
  }

  /**
   * Helper for tests: reset all in-memory state.
   */
  _reset() {
    this._sessions.clear();
  }
}

/** @type {DownloadsTriageService|null} */
let _instance = null;

function getDownloadsTriageService() {
  if (!_instance) _instance = new DownloadsTriageService();
  return _instance;
}

module.exports = {
  DownloadsTriageService,
  getDownloadsTriageService,
  buildTriageScanIgnorePatterns,
  resolveMtimeMs,
  triagePathKey,
  BUCKET,
  SIGNAL,
  SESSION_TTL_MS,
  MAX_CONCURRENT_SESSIONS
};
