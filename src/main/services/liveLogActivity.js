// @ts-check
/**
 * Live Activity classifier: turns one sanitized logger record into a
 * plain-language Activity line, or null when the record is not an event the
 * panel recognizes.
 *
 * Pure and synchronous. It runs inside the logger's live-record listener
 * path (src/main/services/liveLogFeed.js), so it must never log, throw, or
 * touch I/O.
 *
 * Each rule names the logger context(s) it trusts (null = any context; used
 * where the caller injects its own logger) and the message the source module
 * writes. Messages arrive AFTER sanitizeLogData, so absolute paths look like
 * `[REDACTED_PATH]\name.ext`; file names are taken from the last path
 * segment. When a rule's builder returns null the next rule is tried; any
 * warn/error/fatal record nothing claimed becomes a "Problem:" line.
 */

/**
 * @typedef {'info' | 'success' | 'warn' | 'error'} ActivityTone
 * @typedef {{ kind: string, icon: string, text: string, file?: string, tone: ActivityTone }} LiveActivity
 * @typedef {{ level: string, context?: string, msg: string, data?: any }} ActivityInput
 * @typedef {(input: ActivityInput, match: RegExpMatchArray) => (LiveActivity | null)} ActivityBuilder
 * @typedef {{ id: string, contexts: string[] | null, pattern: RegExp, build: ActivityBuilder }} ActivityRule
 */

const path = require('path');
const {
  ANALYSIS_SUPPORTED_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} = require('../../shared/constants');

const MAX_TEXT_CHARS = 300;
const MAX_FILE_CHARS = 120;
const REDACTED_PATH = '[REDACTED_PATH]';
const PROBLEM_LEVELS = new Set(['warn', 'error', 'fatal']);
const PROBLEM_FALLBACK_TEXT = 'Something went wrong';
/** Extensions SmartFolderWatcher sends to an analyzer (else: metadata fallback). */
const ANALYZED_EXTENSIONS = new Set(ANALYSIS_SUPPORTED_EXTENSIONS);
const MEDIA_EXTENSIONS = new Set([...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS]);
/** Orama collection names as the user knows them; unknown names are left out. */
const COLLECTION_WORDS = Object.freeze({
  files: 'files',
  fileChunks: 'passages',
  folders: 'folders',
  feedback: 'learning',
  learningPatterns: 'learning'
});
/** `[REDACTED_PATH]\name` / `[REDACTED_PATH]/name`: the logger's redacted path. */
const REDACTED_PATH_TOKEN = /\[REDACTED_PATH\][\\/]/g;
/** The file name right after the first redacted-path token. */
const REDACTED_PATH_FILE = /\[REDACTED_PATH\][\\/]([^\s\\/:*?"<>|]+)/;

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} prefix */
function prefixPattern(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}(.*)$`);
}

/**
 * Last path segment of a (possibly redacted) path, or undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function baseName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]/);
  const last = (parts[parts.length - 1] || '').trim();
  if (!last || last === REDACTED_PATH || last === 'N/A') return undefined;
  return last.length > MAX_FILE_CHARS ? `${last.slice(0, MAX_FILE_CHARS - 1)}…` : last;
}

/**
 * Name of the folder that holds the file, when the path still carries it.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function parentFolderName(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const parent = parts[parts.length - 2].trim();
  if (!parent || parent === REDACTED_PATH) return undefined;
  return parent;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** @param {unknown} value */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {number} n
 * @param {string} noun
 */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** @param {string} value */
function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** @param {string | undefined} file */
function orAFile(file) {
  return file || 'a file';
}

/**
 * @param {string} kind
 * @param {string} icon
 * @param {ActivityTone} tone
 * @param {string} line
 * @param {string} [file]
 * @returns {LiveActivity}
 */
function activity(kind, icon, tone, line, file) {
  /** @type {LiveActivity} */
  const result = {
    kind,
    icon,
    tone,
    text: line.length > MAX_TEXT_CHARS ? `${line.slice(0, MAX_TEXT_CHARS - 1)}…` : line
  };
  if (file) result.file = file;
  return result;
}

/**
 * Drop a leading `[TAG]` (e.g. `[DOWNLOAD-WATCHER]`), but never the logger's
 * `[REDACTED_PATH]` token: that is part of the message, not a tag.
 * @param {string} msg
 */
function stripLeadingTag(msg) {
  const trimmed = msg.trim();
  if (trimmed.startsWith(REDACTED_PATH)) return trimmed;
  return trimmed.replace(/^\[[^\]]+\]\s*/, '').trim();
}

/**
 * A "Problem: …" line. Redacted-path tokens are dropped from the text (the
 * file name stays) and the first such name becomes `file`, so the panel's
 * redact mode can hide it.
 * @param {string} message
 * @param {ActivityTone} tone
 * @returns {LiveActivity}
 */
function problem(message, tone) {
  const fileMatch = message.match(REDACTED_PATH_FILE);
  const rawFile = fileMatch ? fileMatch[1].replace(/[.,;)'"]+$/, '') : '';
  const file = rawFile ? baseName(rawFile) : undefined;
  const shown = message.replace(REDACTED_PATH_TOKEN, '').trim();
  return activity('problem', 'alert', tone, `Problem: ${shown || PROBLEM_FALLBACK_TEXT}`, file);
}

/**
 * @param {string} id
 * @param {string[] | null} contexts
 * @param {string} prefix
 * @param {ActivityBuilder} build
 * @returns {ActivityRule}
 */
function prefixRule(id, contexts, prefix, build) {
  return { id, contexts, pattern: prefixPattern(prefix), build };
}

/**
 * @param {string} id
 * @param {string[] | null} contexts
 * @param {RegExp} pattern
 * @param {ActivityBuilder} build
 * @returns {ActivityRule}
 */
function patternRule(id, contexts, pattern, build) {
  return { id, contexts, pattern, build };
}

/** @type {ActivityBuilder} */
const analyzedWithCategory = (input) => {
  const file = baseName(input.data?.fileName);
  const category = text(input.data?.category);
  return activity(
    'analyzed',
    'check',
    'success',
    category ? `Analyzed ${orAFile(file)} → ${category}` : `Analyzed ${orAFile(file)}`,
    file
  );
};

/** @type {ActivityBuilder} */
const folderSuggestion = (input) => {
  const folder = text(input.data?.suggestedNewFolder);
  if (!folder) return null;
  const file = baseName(input.data?.fileName);
  return activity(
    'folder-suggestion',
    'sparkles',
    'info',
    file ? `Suggested a new folder "${folder}" for ${file}` : `Suggested a new folder "${folder}"`,
    file
  );
};

/**
 * True when the watcher's "Analysis complete" is the only success line a file
 * gets: audio/video (the media analyzer logs no success line) and types with
 * no analyzer at all (the watcher's metadata fallback). Documents and images
 * already read "Analyzed <file> → <category>" from their analyzer.
 * @param {string} file
 */
function watcherIsOnlySuccessLine(file) {
  const ext = path.extname(file).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext) || !ANALYZED_EXTENSIONS.has(ext);
}

/** @param {unknown} filePath */
const analyzingFromPath = (filePath) => {
  const file = baseName(filePath);
  return activity('analyze', 'analyze', 'info', `Analyzing ${orAFile(file)}`, file);
};

const WATCHER = ['SmartFolderWatcher'];
const IMAGE = ['ImageAnalysis'];
const DOCUMENT = ['DocumentAnalysis'];
const VISION = ['VisionService'];
const LLAMA = ['LlamaService'];
const MEMORY = ['ModelMemoryManager'];
const DEGRADED = ['DegradedStateTracker'];
const FILE_PROCESSOR = ['AutoOrganize-FileProcessor'];
const DOWNLOADS = ['DownloadWatcher'];
const SEARCH = ['SearchService'];
/** @type {null} Rule context list meaning "trust any logger context". */
const ANY = null;

/** @type {ActivityRule[]} */
const RULES = [
  // The watcher's own "Analyzing file:" line is not a rule: the document and
  // image analyzers already announce the same file.
  prefixRule('watcher-queued', WATCHER, '[SMART-FOLDER-WATCHER] Queued for analysis:', (input) => {
    const file = baseName(input.data?.filePath);
    return activity('analyze', 'analyze', 'info', `Queued ${orAFile(file)} for analysis`, file);
  }),
  prefixRule('watcher-complete', WATCHER, '[SMART-FOLDER-WATCHER] Analysis complete:', (_i, m) => {
    const file = baseName(m[1]);
    if (!file || !watcherIsOnlySuccessLine(file)) return null;
    return activity('analyzed', 'check', 'success', `Analyzed ${file}`, file);
  }),
  prefixRule('document-analyzing', DOCUMENT, 'Analyzing document file', (input) =>
    analyzingFromPath(input.data?.path)
  ),
  prefixRule('image-analyzing', IMAGE, 'Analyzing image file', (input) =>
    analyzingFromPath(input.data?.path)
  ),
  prefixRule(
    'document-analyzed',
    DOCUMENT,
    '[AI-ANALYSIS-SUCCESS] Document analyzed',
    analyzedWithCategory
  ),
  prefixRule('image-analyzed', IMAGE, '[AI-ANALYSIS-SUCCESS] Image analyzed', analyzedWithCategory),
  prefixRule(
    'image-folder-suggestion',
    IMAGE,
    '[ImageAnalysis] Surfaced new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'document-folder-suggestion',
    ANY,
    '[DocumentLLM] Surfaced new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'matcher-folder-suggestion',
    ['SemanticFolderMatcher'],
    '[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'folder-fallback',
    ['FolderMatchingService'],
    '[FolderMatching] No match across',
    (input) => {
      const raw = text(input.data?.rawCategory);
      const fallback = text(input.data?.fallbackFolder);
      if (!fallback) return null;
      return activity(
        'folder-fallback',
        'folder',
        'info',
        raw
          ? `No folder matched "${raw}"; using ${fallback}`
          : `No folder matched; using ${fallback}`
      );
    }
  ),
  prefixRule('vision-starting', VISION, '[VisionService] Starting vision runtime', () =>
    activity('vision', 'eye', 'info', 'Starting vision model')
  ),
  prefixRule('vision-ready', VISION, '[VisionService] Vision runtime ready', (input) =>
    activity(
      'vision',
      'eye',
      'success',
      input.data?.gpuActive === true ? 'Vision model ready (GPU)' : 'Vision model ready'
    )
  ),
  prefixRule('vision-stopping', VISION, '[VisionService] Shutting down vision runtime', () =>
    activity('vision', 'eye', 'info', 'Stopping vision model')
  ),
  prefixRule('vision-batch-entered', LLAMA, '[LlamaService] Entered vision batch mode', () =>
    activity('vision', 'eye', 'info', 'Vision batch started')
  ),
  prefixRule('vision-batch-exited', LLAMA, '[LlamaService] Exited vision batch mode', () =>
    activity('vision', 'eye', 'success', 'Vision batch finished')
  ),
  patternRule('model-loading', LLAMA, /^\[LlamaService\] Loading (\w+) model:/, (_i, m) =>
    activity('model', 'cpu', 'info', `Loading ${m[1]} model`)
  ),
  prefixRule('model-loaded', MEMORY, '[Memory] Model loaded', (input) => {
    const type = text(input.data?.type);
    return activity(
      'model',
      'cpu',
      'success',
      type ? `${capitalize(type)} model loaded` : 'Model loaded'
    );
  }),
  prefixRule('model-unloading', MEMORY, '[Memory] Unloading model', (input) => {
    const type = text(input.data?.type);
    return activity('model', 'cpu', 'info', type ? `Unloading ${type} model` : 'Unloading a model');
  }),
  prefixRule(
    'embedding-unloaded-for-vision',
    LLAMA,
    '[LlamaService] Unloaded the CPU embedding model from the vision batch',
    () => activity('model', 'cpu', 'info', 'Embedding model unloaded for the vision batch')
  ),
  prefixRule(
    'embeddings-flushed',
    ['EmbeddingQueue'],
    '[EmbeddingQueue] Successfully flushed batch',
    (input) => {
      const saved = count(input.data?.success);
      const failed = count(input.data?.failed);
      if (saved === 0 && failed > 0) {
        return activity(
          'embeddings',
          'database',
          'warn',
          `${plural(failed, 'search embedding')} failed to save`
        );
      }
      return failed > 0
        ? activity(
            'embeddings',
            'database',
            'warn',
            `Saved ${plural(saved, 'search embedding')}, ${failed} failed`
          )
        : activity(
            'embeddings',
            'database',
            'success',
            `Saved ${plural(saved, 'search embedding')}`
          );
    }
  ),
  prefixRule(
    'index-saved',
    ['OramaVectorService'],
    '[OramaVectorService] Persisted databases',
    (input) => {
      const raw = input.data?.collections;
      /** @type {Set<string>} */
      const words = new Set();
      if (Array.isArray(raw)) {
        for (const name of raw) {
          const word =
            typeof name === 'string' && Object.hasOwn(COLLECTION_WORDS, name)
              ? COLLECTION_WORDS[/** @type {keyof typeof COLLECTION_WORDS} */ (name)]
              : undefined;
          if (word) words.add(word);
        }
      }
      return activity(
        'index-saved',
        'save',
        'success',
        words.size > 0 ? `Saved search index (${[...words].join(', ')})` : 'Saved search index'
      );
    }
  ),
  prefixRule('storage-full', DEGRADED, '[DegradedState] flag raised', (input) =>
    input.data?.code === 'storage.full'
      ? activity('storage', 'hard-drive', 'error', 'Disk is full; saving is paused')
      : null
  ),
  prefixRule('degraded-raised', DEGRADED, '[DegradedState] flag raised', (input) => {
    const message =
      text(input.data?.message) ||
      text(input.data?.code) ||
      'A part of the app is not working normally';
    return problem(message, input.data?.severity === 'error' ? 'error' : 'warn');
  }),
  prefixRule('storage-cleared', DEGRADED, '[DegradedState] flag cleared', (input) =>
    input.data?.code === 'storage.full'
      ? activity('storage', 'hard-drive', 'success', 'Disk has room again; saving resumed')
      : null
  ),
  patternRule(
    'organize-batch-start',
    ANY,
    /^\[FILE-OPS\] Starting batch operation \S+ with (\d+) files?/,
    (_i, m) => activity('organize', 'folder', 'info', `Organizing ${plural(Number(m[1]), 'file')}`)
  ),
  prefixRule('organize-move', ANY, '[FILE-OPS] Move completed', (input) => {
    const file = baseName(input.data?.source) || baseName(input.data?.destination);
    const folder = parentFolderName(input.data?.destination);
    return activity(
      'organize',
      'folder',
      'success',
      folder ? `Filed ${orAFile(file)} → ${folder}` : `Filed ${orAFile(file)}`,
      file
    );
  }),
  prefixRule('organize-skipped', ANY, '[FILE-OPS] Move skipped (duplicate)', (input) => {
    const file = baseName(input.data?.source) || baseName(input.data?.destination);
    return activity(
      'organize',
      'folder',
      'info',
      `Skipped ${orAFile(file)} (already in place)`,
      file
    );
  }),
  prefixRule('organize-paused', ANY, '[FILE-OPS] Batch paused by user', () =>
    activity('organize', 'folder', 'info', 'Organizing paused')
  ),
  prefixRule(
    'auto-organize-file',
    FILE_PROCESSOR,
    '[AutoOrganize] Auto-organizing new file',
    (input) => {
      const file = baseName(input.data?.file);
      const folder = parentFolderName(input.data?.destination);
      return activity(
        'organize',
        'folder',
        'info',
        folder ? `Filing ${orAFile(file)} → ${folder}` : `Filing ${orAFile(file)}`,
        file
      );
    }
  ),
  prefixRule(
    'auto-organize-held',
    FILE_PROCESSOR,
    '[AutoOrganize] Holding file for review (not moved)',
    (input) => {
      const file = baseName(input.data?.file);
      const folder = text(input.data?.suggestedFolder);
      return activity(
        'organize',
        'folder',
        'info',
        folder
          ? `Holding ${orAFile(file)} for review (suggested: ${folder})`
          : `Holding ${orAFile(file)} for review`,
        file
      );
    }
  ),
  prefixRule(
    'auto-organize-complete',
    ['AutoOrganizeService'],
    '[AutoOrganize] Organization complete',
    (input) => {
      const organized = count(input.data?.organized);
      const review = count(input.data?.needsReview);
      const failed = count(input.data?.failed);
      const line = `Organize finished: ${organized} filed, ${review} to review${
        failed > 0 ? `, ${failed} failed` : ''
      }`;
      return activity('organize', 'folder', failed > 0 ? 'warn' : 'success', line);
    }
  ),
  prefixRule(
    'undo-restore',
    ['UndoRedoService'],
    '[UndoRedoService] Restoring file from backup',
    (input) => {
      const file = baseName(input.data?.to);
      return activity('undo', 'undo', 'info', `Undo: restoring ${orAFile(file)}`, file);
    }
  ),
  patternRule(
    'download-organized',
    DOWNLOADS,
    /^\[DOWNLOAD-WATCHER\] Auto-organized with \S+% confidence: (.*?) => (.*)$/,
    (_i, m) => {
      const file = baseName(m[1]);
      const folder = parentFolderName(m[2]);
      return activity(
        'download',
        'download',
        'success',
        folder ? `Filed download ${orAFile(file)} → ${folder}` : `Filed download ${orAFile(file)}`,
        file
      );
    }
  ),
  patternRule(
    'download-renamed',
    DOWNLOADS,
    /^\[DOWNLOAD-WATCHER\] Moved \(fallback, renamed due to conflict\) (.*?) => (.*)$/,
    (_i, m) => {
      const file = baseName(m[1]);
      return activity(
        'download',
        'download',
        'success',
        `Filed download ${orAFile(file)} (renamed)`,
        file
      );
    }
  ),
  prefixRule(
    'download-left',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)',
    () =>
      activity(
        'download',
        'download',
        'info',
        'Left a download in place (low confidence or auto-organize off)'
      )
  ),
  prefixRule(
    'download-held',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] Disk full; holding new download',
    (input) => {
      const file = baseName(input.data?.filePath);
      return activity(
        'storage',
        'hard-drive',
        'warn',
        `Holding download ${orAFile(file)} until the disk has room`,
        file
      );
    }
  ),
  prefixRule(
    'download-resumed',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] Disk has room again; processing held downloads',
    () =>
      activity('storage', 'download', 'success', 'Disk has room again; processing held downloads')
  ),
  prefixRule('search-building', SEARCH, '[SearchService] Building BM25 index...', () =>
    activity('search-index', 'search', 'info', 'Building search index')
  ),
  patternRule(
    'search-built',
    SEARCH,
    /^\[SearchService\] BM25 index built with (\d+) documents/,
    (_i, m) =>
      activity(
        'search-index',
        'search',
        'success',
        `Search index built (${plural(Number(m[1]), 'document')})`
      )
  ),
  prefixRule(
    'knowledge-repair',
    ['KnowledgeRepair'],
    'Startup knowledge repair complete',
    (input) => {
      const restored = count(input.data?.restored);
      const embedded = count(input.data?.embedded);
      const passages = count(input.data?.passages);
      const failed = count(input.data?.failed);
      const deferred = count(input.data?.deferred);
      const line = `Knowledge repair: ${restored} restored, ${embedded} embedded, ${passages} passages${
        failed > 0 ? `, ${failed} failed` : ''
      }${deferred > 0 ? `, ${deferred} deferred` : ''}`;
      return activity('knowledge-repair', 'wrench', failed > 0 ? 'warn' : 'success', line);
    }
  )
];

/**
 * @param {ActivityInput | null | undefined} record
 * @returns {LiveActivity | null}
 */
function activityFromLogRecord(record) {
  if (!record || typeof record.msg !== 'string') return null;
  const context = typeof record.context === 'string' ? record.context : '';
  for (const rule of RULES) {
    if (rule.contexts && !rule.contexts.includes(context)) continue;
    // Non-global patterns: String#match returns the same groups as RegExp exec.
    const match = record.msg.match(rule.pattern);
    if (!match) continue;
    /** @type {LiveActivity | null} */
    let result;
    try {
      result = rule.build(record, match);
    } catch {
      result = null;
    }
    if (result) return result;
  }
  if (PROBLEM_LEVELS.has(record.level)) {
    return problem(stripLeadingTag(record.msg), record.level === 'warn' ? 'warn' : 'error');
  }
  return null;
}

const ACTIVITY_RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));

module.exports = { activityFromLogRecord, ACTIVITY_RULE_IDS };
