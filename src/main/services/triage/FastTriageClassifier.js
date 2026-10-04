// @ts-check
/**
 * FastTriageClassifier — Phase 3 Tier 0.
 *
 * Classifies a single file against user context using *only* metadata
 * (path, size, mtime, filename) plus cached signals from earlier work:
 *   - hash lookups via OramaVectorService.findByHash (populated by Phase 1's
 *     fileHash column + reindex action)
 *   - cached embeddings via AnalysisHistoryService.getAnalysisByPath
 *
 * No LLM, no new embedding inference, no content read. A folder of 2000
 * Downloads files should classify in well under a second on typical hardware.
 * Anything that doesn't hit a high-confidence signal is returned as
 * `ambiguous` so the user can opt in to the Tier 1 embedding pass.
 *
 * The cascade (in priority order):
 *
 *   1. Inside a Smart Folder path                -> excluded  (already organized)
 *   2. Matches an exclusion glob                 -> excluded  (installer, .part, etc.)
 *   3. Modified within minAgeMs                  -> excluded  (too recent)
 *   4. SHA-256 collision with an organized copy  -> trash     (safe duplicate)
 *   5. Cached embedding + folder vector match    -> keep/review (reuse analysis)
 *   6. Lexical match against folder keywords     -> keep (if strong) / ambiguous
 *   fallback                                      -> ambiguous (needs deep scan)
 */

const path = require('path');
const { findMatchingExclusion } = require('../watcherExclusions');
const { createLogger } = require('../../../shared/logger');
const { THRESHOLDS } = require('../../../shared/performanceConstants');
const { isCaseInsensitiveFileSystem } = require('../../../shared/crossPlatformUtils');

const logger = createLogger('FastTriageClassifier');

const BUCKET = Object.freeze({
  KEEP: 'keep',
  TRASH: 'trash',
  EXCLUDED: 'excluded',
  AMBIGUOUS: 'ambiguous'
});

const SIGNAL = Object.freeze({
  INSIDE_SMART_FOLDER: 'inside-smart-folder',
  PATTERN_EXCLUSION: 'pattern-exclusion',
  TOO_RECENT: 'too-recent',
  HASH_COLLISION: 'hash-collision',
  CACHED_EMBEDDING: 'cached-embedding',
  LEXICAL_MATCH: 'lexical-match',
  NO_MATCH: 'no-match'
});

// Mirrors triagePathKey() in DownloadsTriageService.js so the classifier and
// the session lookup agree on what "same path" means. On Linux this preserves
// case (filesystem is case-sensitive); on win32/darwin it lowercases. Without
// this alignment, a Linux user's smart folder root /home/user/Reports won't
// match a file at /home/user/Reports/x.pdf inside the classifier (true) but
// the session-side path-key lookup misses, leaving the file as a phantom
// "keep-worthy" row that triage actions silently no-op on.
function _platformNormalize(/** @type {any} */ p) {
  if (!p) return '';
  let s = String(p);
  try {
    s = s.normalize('NFC');
  } catch {
    /* invalid surrogate */
  }
  if (isCaseInsensitiveFileSystem()) {
    s = s.toLowerCase();
  }
  return s.replace(/\\/g, '/');
}

function isInsideAny(/** @type {any} */ filePath, /** @type {any} */ rootPaths) {
  if (!filePath || !Array.isArray(rootPaths) || rootPaths.length === 0) return null;
  const target = _platformNormalize(filePath);
  for (const root of rootPaths) {
    const r = _platformNormalize(root);
    if (!r) continue;
    if (target === r || target.startsWith(r.endsWith('/') ? r : `${r}/`)) {
      return root;
    }
  }
  return null;
}

/**
 * Same matcher as the live watchers (watcherExclusions), given the full path
 * so folder rules such as `**\/archived/**` read the same in the sweep, and
 * the scanned folder so a relative one (`archived/**`) is read beneath it,
 * never against the root's own ancestors.
 * @param {any} filePathOrName
 * @param {any} globs
 * @param {any} [root]  the folder being swept
 */
function matchesAnyGlob(filePathOrName, globs, root = null) {
  if (typeof filePathOrName !== 'string' || !filePathOrName) return null;
  return findMatchingExclusion(filePathOrName, Array.isArray(globs) ? globs : [], {
    root: typeof root === 'string' ? root : null
  });
}

function tokenizeFileName(/** @type {any} */ fileName) {
  if (!fileName) return [];
  const base = path.basename(String(fileName));
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  const parts = stem
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  const tokens = new Set(parts);
  if (ext) tokens.add(ext.toLowerCase());
  // Note: semantic-extension concepts are intentionally NOT added here. They
  // balloon the token set with many loosely-related terms (e.g. .pdf pulls in
  // 'finance', 'legal', 'tax', 'contract') which dilutes the Jaccard score
  // and turns strong filename matches into weak ones. Extension-aware
  // matching lives on the folder side via enrichFolderTextForEmbedding and
  // the vector matcher — this lexical path stays focused on the filename.
  return Array.from(tokens);
}

function confidencePercent(/** @type {any} */ score01) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(score01) || 0)) * 100);
  return pct;
}

class FastTriageClassifier {
  /**
   * @param {Record<string, any>} [deps] - { oramaService, analysisHistory, folderMatchingService, hashCache, computeFileChecksum }
   */
  constructor(deps = {}) {
    this.oramaService = deps.oramaService || null;
    this.analysisHistory = deps.analysisHistory || null;
    this.folderMatching = deps.folderMatchingService || null;
    this.hashCache = deps.hashCache || null;
    this.computeFileChecksum = deps.computeFileChecksum || null;
  }

  /**
   * @param {Record<string, any>} entry - {filePath, size, mtimeMs, fileName}
   * @param {Record<string, any>} context - { smartFolders, smartFolderPaths, exclusionGlobs, folderPath, minAgeMs, nowMs }
   *   `folderPath` is the folder being swept; relative folder rules read beneath it.
   * @returns {Promise<Record<string, any>>} classification result
   */
  async classifyFile(entry, context) {
    const now = Number.isFinite(context?.nowMs) ? context.nowMs : Date.now();
    const minAgeMs = Number.isFinite(context?.minAgeMs) ? context.minAgeMs : 24 * 60 * 60 * 1000;
    const smartFolders = Array.isArray(context?.smartFolders) ? context.smartFolders : [];
    const smartFolderPaths = Array.isArray(context?.smartFolderPaths)
      ? context.smartFolderPaths
      : smartFolders.map((f) => f?.path).filter(Boolean);
    const exclusionGlobs = Array.isArray(context?.exclusionGlobs) ? context.exclusionGlobs : [];
    const folderPath = typeof context?.folderPath === 'string' ? context.folderPath : null;

    const filePath = entry?.filePath;
    if (!filePath) {
      return {
        bucket: BUCKET.AMBIGUOUS,
        signal: SIGNAL.NO_MATCH,
        confidence: 0,
        why: 'No file path supplied'
      };
    }

    const fileName = entry.fileName || path.basename(filePath);

    // === Signal 1: already inside an organized (Smart Folder) path ===
    const insideRoot = isInsideAny(filePath, smartFolderPaths);
    if (insideRoot) {
      return {
        bucket: BUCKET.EXCLUDED,
        signal: SIGNAL.INSIDE_SMART_FOLDER,
        confidence: 1,
        why: `Already inside organized folder: ${insideRoot}`
      };
    }

    // === Signal 2: pattern exclusion ===
    const matchedGlob = matchesAnyGlob(filePath, exclusionGlobs, folderPath);
    if (matchedGlob) {
      return {
        bucket: BUCKET.EXCLUDED,
        signal: SIGNAL.PATTERN_EXCLUSION,
        confidence: 1,
        why: `Excluded by rule: ${matchedGlob}`
      };
    }

    // === Signal 3: too-recent ===
    const mtime = Number(entry.mtimeMs) || 0;
    if (mtime > 0 && now - mtime < minAgeMs) {
      const hoursOld = Math.max(0, Math.round((now - mtime) / (60 * 60 * 1000)));
      return {
        bucket: BUCKET.EXCLUDED,
        signal: SIGNAL.TOO_RECENT,
        confidence: 1,
        why: `Too recent (${hoursOld}h old — wait before triaging)`
      };
    }

    // === Signal 4: hash collision with organized file ===
    if (this.computeFileChecksum && this.oramaService?.findByHash && Number.isFinite(mtime)) {
      try {
        const sha256 = await this.computeFileChecksum(filePath, {
          cache: this.hashCache,
          stat: { size: entry.size || 0, mtimeMs: mtime }
        });
        const matches = await this.oramaService.findByHash(sha256, { limit: 20 });
        const organized = (matches || []).find((/** @type {any} */ doc) => {
          const docPath = doc?.filePath;
          if (!docPath || docPath === filePath) return false;
          return Boolean(isInsideAny(docPath, smartFolderPaths));
        });
        if (organized) {
          return {
            bucket: BUCKET.TRASH,
            signal: SIGNAL.HASH_COLLISION,
            confidence: 1,
            suggestedFolder: null,
            why: `Exact duplicate of organized file: ${organized.filePath}`,
            hash: sha256,
            organizedPath: organized.filePath
          };
        }
      } catch (err) {
        logger.debug('[FastTriageClassifier] hash-collision check failed', {
          filePath,
          error: err?.message
        });
      }
    }

    // === Signal 5: cached embedding -> folder vector match ===
    if (this.analysisHistory?.getAnalysisByPath && this.folderMatching?.matchVectorToFolders) {
      try {
        const entryRecord = await this.analysisHistory.getAnalysisByPath(filePath);
        const vector = entryRecord?.embedding?.vector;
        const model = entryRecord?.embedding?.model;
        if (Array.isArray(vector) && vector.length > 0) {
          const matches = await this.folderMatching.matchVectorToFolders(vector, 3);
          const top = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
          const score = Number(top?.confidence ?? top?.score ?? 0);
          if (top && score >= THRESHOLDS.FOLDER_MATCH_CONFIDENCE) {
            return {
              bucket: BUCKET.KEEP,
              signal: SIGNAL.CACHED_EMBEDDING,
              confidence: score,
              suggestedFolder: { id: top.id, name: top.name, path: top.path },
              why: `Cached embedding matches folder "${top.name || top.id}" (${confidencePercent(score)}%${model ? `, model ${model}` : ''})`
            };
          }
          if (top && score >= 0.4) {
            return {
              bucket: BUCKET.AMBIGUOUS,
              signal: SIGNAL.CACHED_EMBEDDING,
              confidence: score,
              suggestedFolder: { id: top.id, name: top.name, path: top.path },
              why: `Cached embedding suggests "${top.name || top.id}" (${confidencePercent(score)}%) — below confidence threshold`
            };
          }
        }
      } catch (err) {
        logger.debug('[FastTriageClassifier] cached-embedding match failed', {
          filePath,
          error: err?.message
        });
      }
    }

    // === Signal 6: lexical match against smart folder keywords ===
    if (this.folderMatching?.matchTokensToFolders && smartFolders.length > 0) {
      try {
        const tokens = tokenizeFileName(fileName);
        const ranked = this.folderMatching.matchTokensToFolders(tokens, smartFolders, {
          topK: 3
        });
        const top = ranked[0];
        if (top && top.score >= 0.35) {
          return {
            bucket: BUCKET.KEEP,
            signal: SIGNAL.LEXICAL_MATCH,
            confidence: top.score,
            suggestedFolder: { id: top.id, name: top.name, path: top.path },
            why: `Matches "${top.name}" keywords: ${top.matchedTokens.slice(0, 3).join(', ')}`
          };
        }
        if (top && top.score > 0) {
          return {
            bucket: BUCKET.AMBIGUOUS,
            signal: SIGNAL.LEXICAL_MATCH,
            confidence: top.score,
            suggestedFolder: { id: top.id, name: top.name, path: top.path },
            why: `Weak keyword match to "${top.name}" — needs deeper scan to confirm`
          };
        }
      } catch (err) {
        logger.debug('[FastTriageClassifier] lexical match failed', {
          filePath,
          error: err?.message
        });
      }
    }

    // === Fallback: AMBIGUOUS — needs deep scan ===
    return {
      bucket: BUCKET.AMBIGUOUS,
      signal: SIGNAL.NO_MATCH,
      confidence: 0,
      why: 'Needs deeper scan to classify'
    };
  }
}

module.exports = {
  FastTriageClassifier,
  BUCKET,
  SIGNAL,
  // Exposed for tests:
  _tokenizeFileName: tokenizeFileName,
  _isInsideAny: isInsideAny,
  _matchesAnyGlob: matchesAnyGlob
};
