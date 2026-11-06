/**
 * Table-driven tests for the Live Activity classifier. Every message below is
 * the real log line as it reaches the logger listener: after util.format and
 * sanitizeLogData, so absolute paths look like `[REDACTED_PATH]\name.ext`.
 */
// The suite-wide fs mock is an in-memory volume; the contract checks read real source.
const fs = jest.requireActual('fs');
const path = require('path');
const {
  activityFromLogRecord,
  ACTIVITY_RULE_IDS
} = require('../../../src/main/services/liveLogActivity');
const { IPC_CHANNELS } = require('../../../src/shared/constants');
const { validateEventPayload } = require('../../../src/shared/ipcEventSchemas');

/**
 * Wrap one activity in a one-entry live-log batch and validate it, so a rule
 * whose kind, icon, tone, text or file outgrows the batch schema fails here.
 * @param {object | null} activity
 */
function batchSchemaIssues(activity) {
  const result = validateEventPayload(IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH, {
    entries: [
      {
        id: 1,
        time: '2026-11-05T09:00:00.000Z',
        level: 'info',
        context: 'Test',
        msg: 'm',
        dataText: '',
        activity
      }
    ],
    dropped: 0
  });
  return result.valid ? [] : result.error.issues;
}

const CASES = [
  {
    rule: 'watcher-queued',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
      data: { filePath: '[REDACTED_PATH]\\invoice.pdf', eventType: 'add' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Queued invoice.pdf for analysis',
      file: 'invoice.pdf'
    }
  },
  {
    rule: 'watcher-complete',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]/voice-memo.m4a'
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed voice-memo.m4a',
      file: 'voice-memo.m4a'
    }
  },
  {
    rule: 'watcher-complete',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]\\lease.docx'
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed lease.docx',
      file: 'lease.docx'
    }
  },
  {
    rule: 'document-analyzing',
    record: {
      level: 'info',
      context: 'DocumentAnalysis',
      msg: 'Analyzing document file',
      data: { path: '[REDACTED_PATH]\\lease.docx' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing lease.docx',
      file: 'lease.docx'
    }
  },
  {
    rule: 'image-analyzing',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: 'Analyzing image file',
      data: { path: '[REDACTED_PATH]/IMG_2041.HEIC' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing IMG_2041.HEIC',
      file: 'IMG_2041.HEIC'
    }
  },
  {
    rule: 'document-analyzed',
    record: {
      level: 'info',
      context: 'DocumentAnalysis',
      msg: '[AI-ANALYSIS-SUCCESS] Document analyzed',
      data: { fileName: 'lease.docx', category: 'Housing', confidence: 0.9 }
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed lease.docx → Housing',
      file: 'lease.docx'
    }
  },
  {
    rule: 'image-analyzed',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: '[AI-ANALYSIS-SUCCESS] Image analyzed',
      data: { fileName: 'receipt-0412.jpg', category: 'Financial', confidence: 0.82 }
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed receipt-0412.jpg → Financial',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'image-folder-suggestion',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: '[ImageAnalysis] Surfaced new-folder suggestion',
      data: { fileName: 'IMG_2041.HEIC', rawLlmCategory: 'Pets', suggestedNewFolder: 'Pets' }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Pets" for IMG_2041.HEIC',
      file: 'IMG_2041.HEIC'
    }
  },
  {
    rule: 'document-folder-suggestion',
    record: {
      level: 'info',
      context: 'DocumentLLM',
      msg: '[DocumentLLM] Surfaced new-folder suggestion',
      data: { fileName: 'lease.docx', rawLlmCategory: 'Housing', suggestedNewFolder: 'Housing' }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Housing" for lease.docx',
      file: 'lease.docx'
    }
  },
  {
    rule: 'matcher-folder-suggestion',
    record: {
      level: 'info',
      context: 'SemanticFolderMatcher',
      msg: '[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion',
      data: { type: 'document', suggestedNewFolder: 'Recipes', topEmbeddingScore: 0.31 }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Recipes"'
    }
  },
  {
    rule: 'folder-fallback',
    record: {
      level: 'info',
      context: 'FolderMatchingService',
      msg: '[FolderMatching] No match across exact/canonical/levenshtein/prefix/token/description; using fallback',
      data: { rawCategory: 'Gadgets', fallbackFolder: 'Uncategorized', availableFolders: ['Work'] }
    },
    expected: {
      kind: 'folder-fallback',
      icon: 'folder',
      tone: 'info',
      text: 'No folder matched "Gadgets"; using Uncategorized'
    }
  },
  {
    rule: 'vision-starting',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Starting vision runtime',
      data: { port: 8080 }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Starting vision model' }
  },
  {
    rule: 'vision-ready',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Vision runtime ready',
      data: { port: 8080, backend: 'cuda', gpuActive: true }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision model ready (GPU)' }
  },
  {
    rule: 'vision-ready',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Vision runtime ready',
      data: { port: 8080, backend: 'cpu', gpuActive: false }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision model ready' }
  },
  {
    rule: 'vision-stopping',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Shutting down vision runtime'
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Stopping vision model' }
  },
  {
    rule: 'vision-batch-entered',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Entered vision batch mode',
      data: { refs: 1 }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Vision batch started' }
  },
  {
    rule: 'vision-batch-exited',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Exited vision batch mode'
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision batch finished' }
  },
  {
    rule: 'model-loading',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Loading embedding model: nomic-embed-text-v1.5.Q8_0.gguf'
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'info', text: 'Loading embedding model' }
  },
  {
    rule: 'model-loaded',
    record: {
      level: 'info',
      context: 'ModelMemoryManager',
      msg: '[Memory] Model loaded',
      data: { type: 'text', currentUsageMB: 4100 }
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'success', text: 'Text model loaded' }
  },
  {
    rule: 'model-unloading',
    record: {
      level: 'info',
      context: 'ModelMemoryManager',
      msg: '[Memory] Unloading model',
      data: { type: 'embedding' }
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'info', text: 'Unloading embedding model' }
  },
  {
    rule: 'embedding-unloaded-for-vision',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Unloaded the CPU embedding model from the vision batch'
    },
    expected: {
      kind: 'model',
      icon: 'cpu',
      tone: 'info',
      text: 'Embedding model unloaded for the vision batch'
    }
  },
  {
    rule: 'embeddings-flushed',
    record: {
      level: 'info',
      context: 'EmbeddingQueue',
      msg: '[EmbeddingQueue] Successfully flushed batch',
      data: { success: 12, failed: 0, processed: 12, remaining: 0, duration: '420ms' }
    },
    expected: {
      kind: 'embeddings',
      icon: 'database',
      tone: 'success',
      text: 'Saved 12 search embeddings'
    }
  },
  {
    rule: 'embeddings-flushed',
    record: {
      level: 'info',
      context: 'EmbeddingQueue',
      msg: '[EmbeddingQueue] Successfully flushed batch',
      data: { success: 1, failed: 2, processed: 3, remaining: 0, duration: '90ms' }
    },
    expected: {
      kind: 'embeddings',
      icon: 'database',
      tone: 'warn',
      text: 'Saved 1 search embedding, 2 failed'
    }
  },
  {
    rule: 'embeddings-flushed',
    record: {
      level: 'info',
      context: 'EmbeddingQueue',
      msg: '[EmbeddingQueue] Successfully flushed batch',
      data: { success: 0, failed: 3, processed: 3, remaining: 0, duration: '70ms' }
    },
    expected: {
      kind: 'embeddings',
      icon: 'database',
      tone: 'warn',
      text: '3 search embeddings failed to save'
    }
  },
  {
    rule: 'index-saved',
    record: {
      level: 'info',
      context: 'OramaVectorService',
      msg: '[OramaVectorService] Persisted databases',
      data: {
        collections: ['files', 'fileChunks', 'feedback', 'learningPatterns', 'folders', 'mystery'],
        full: true,
        durationMs: 18
      }
    },
    expected: {
      kind: 'index-saved',
      icon: 'save',
      tone: 'success',
      text: 'Saved search index (files, passages, learning, folders)'
    }
  },
  {
    rule: 'index-saved',
    record: {
      level: 'info',
      context: 'OramaVectorService',
      msg: '[OramaVectorService] Persisted databases',
      data: { collections: ['mystery'], full: false, durationMs: 3 }
    },
    expected: { kind: 'index-saved', icon: 'save', tone: 'success', text: 'Saved search index' }
  },
  {
    rule: 'storage-full',
    record: {
      level: 'warn',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag raised',
      data: {
        code: 'storage.full',
        subsystem: 'storage',
        severity: 'error',
        message: 'Your disk is full.'
      }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'error',
      text: 'Disk is full; saving is paused'
    }
  },
  {
    rule: 'degraded-raised',
    record: {
      level: 'warn',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag raised',
      data: {
        code: 'system.metrics-collection-failed',
        subsystem: 'metrics',
        severity: 'warning',
        message: "System health metrics couldn't be collected."
      }
    },
    expected: {
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: "Problem: System health metrics couldn't be collected."
    }
  },
  {
    rule: 'storage-cleared',
    record: {
      level: 'info',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag cleared',
      data: { code: 'storage.full' }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'success',
      text: 'Disk has room again; saving resumed'
    }
  },
  {
    rule: 'organize-batch-start',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Starting batch operation batch_1730800000_ab12 with 14 files',
      data: { batchId: 'batch_1730800000_ab12', totalOperations: 14 }
    },
    expected: { kind: 'organize', icon: 'folder', tone: 'info', text: 'Organizing 14 files' }
  },
  {
    rule: 'organize-move',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Move completed',
      data: {
        batchId: 'b1',
        index: 0,
        source: '[REDACTED_PATH]\\receipt-0412.jpg',
        destination: '[REDACTED_PATH]\\receipt-0412.jpg'
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Filed receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'organize-move',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Move completed',
      data: { source: 'receipt-0412.jpg', destination: 'Financial\\receipt-0412.jpg' }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Filed receipt-0412.jpg → Financial',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'organize-skipped',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Move skipped (duplicate)',
      data: {
        batchId: 'b1',
        source: '[REDACTED_PATH]\\scan.pdf',
        destination: '[REDACTED_PATH]\\scan.pdf'
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'info',
      text: 'Skipped scan.pdf (already in place)',
      file: 'scan.pdf'
    }
  },
  {
    rule: 'organize-paused',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Batch paused by user',
      data: { batchId: 'b1', completed: 3 }
    },
    expected: { kind: 'organize', icon: 'folder', tone: 'info', text: 'Organizing paused' }
  },
  {
    rule: 'auto-organize-file',
    record: {
      level: 'info',
      context: 'AutoOrganize-FileProcessor',
      msg: '[AutoOrganize] Auto-organizing new file',
      data: {
        file: '[REDACTED_PATH]\\scan.pdf',
        destination: '[REDACTED_PATH]\\scan.pdf',
        confidence: 0.91
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'info',
      text: 'Filing scan.pdf',
      file: 'scan.pdf'
    }
  },
  {
    rule: 'auto-organize-held',
    record: {
      level: 'info',
      context: 'AutoOrganize-FileProcessor',
      msg: '[AutoOrganize] Holding file for review (not moved)',
      data: {
        file: '[REDACTED_PATH]/photo.png',
        confidence: 0.4,
        threshold: 0.75,
        suggestedFolder: 'Photos'
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'info',
      text: 'Holding photo.png for review (suggested: Photos)',
      file: 'photo.png'
    }
  },
  {
    rule: 'auto-organize-complete',
    record: {
      level: 'info',
      context: 'AutoOrganizeService',
      msg: '[AutoOrganize] Organization complete',
      data: { organized: 5, needsReview: 2, failed: 0 }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Organize finished: 5 filed, 2 to review'
    }
  },
  {
    rule: 'undo-restore',
    record: {
      level: 'info',
      context: 'UndoRedoService',
      msg: '[UndoRedoService] Restoring file from backup',
      data: { from: '[REDACTED_PATH]\\backup-1.pdf', to: '[REDACTED_PATH]\\contract.pdf' }
    },
    expected: {
      kind: 'undo',
      icon: 'undo',
      tone: 'info',
      text: 'Undo: restoring contract.pdf',
      file: 'contract.pdf'
    }
  },
  {
    rule: 'download-organized',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH]\\statement.pdf => [REDACTED_PATH]\\statement.pdf'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'success',
      text: 'Filed download statement.pdf',
      file: 'statement.pdf'
    }
  },
  {
    rule: 'download-renamed',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Moved (fallback, renamed due to conflict) [REDACTED_PATH]\\setup.exe => [REDACTED_PATH]\\setup (1).exe'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'success',
      text: 'Filed download setup.exe (renamed)',
      file: 'setup.exe'
    }
  },
  {
    rule: 'download-left',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'info',
      text: 'Left a download in place (low confidence or auto-organize off)'
    }
  },
  {
    rule: 'download-held',
    record: {
      level: 'warn',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Disk full; holding new download',
      data: { filePath: '[REDACTED_PATH]\\movie.mkv', held: 1 }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'warn',
      text: 'Holding download movie.mkv until the disk has room',
      file: 'movie.mkv'
    }
  },
  {
    rule: 'download-resumed',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Disk has room again; processing held downloads',
      data: { held: 2 }
    },
    expected: {
      kind: 'storage',
      icon: 'download',
      tone: 'success',
      text: 'Disk has room again; processing held downloads'
    }
  },
  {
    rule: 'search-building',
    record: {
      level: 'info',
      context: 'SearchService',
      msg: '[SearchService] Building BM25 index...'
    },
    expected: { kind: 'search-index', icon: 'search', tone: 'info', text: 'Building search index' }
  },
  {
    rule: 'search-built',
    record: {
      level: 'info',
      context: 'SearchService',
      msg: '[SearchService] BM25 index built with 281 documents'
    },
    expected: {
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (281 documents)'
    }
  },
  {
    rule: 'knowledge-repair',
    record: {
      level: 'info',
      context: 'KnowledgeRepair',
      msg: 'Startup knowledge repair complete',
      data: { restored: 3, embedded: 7, passages: 2, failed: 0, deferred: 0 }
    },
    expected: {
      kind: 'knowledge-repair',
      icon: 'wrench',
      tone: 'success',
      text: 'Knowledge repair: 3 restored, 7 embedded, 2 passages'
    }
  },
  {
    rule: 'knowledge-repair',
    record: {
      level: 'info',
      context: 'KnowledgeRepair',
      msg: 'Startup knowledge repair complete',
      data: { restored: 0, embedded: 4, passages: 0, failed: 1, deferred: 9 }
    },
    expected: {
      kind: 'knowledge-repair',
      icon: 'wrench',
      tone: 'warn',
      text: 'Knowledge repair: 0 restored, 4 embedded, 0 passages, 1 failed, 9 deferred'
    }
  }
];

/**
 * Where each rule's log line lives. `literals` are copied from the source
 * (quotes included, so a reworded or extended message fails); `context` is
 * the createLogger name the rule trusts, or null where the caller injects
 * its logger. A rule whose line was reworded would silently never fire, so
 * this map turns that into a failing test.
 */
const SOURCES = {
  'watcher-queued': {
    file: 'src/main/services/SmartFolderWatcher.js',
    literals: ["'[SMART-FOLDER-WATCHER] Queued for analysis:'"],
    context: 'SmartFolderWatcher'
  },
  'watcher-complete': {
    file: 'src/main/services/SmartFolderWatcher.js',
    literals: ["'[SMART-FOLDER-WATCHER] Analysis complete:'"],
    context: 'SmartFolderWatcher'
  },
  'document-analyzing': {
    file: 'src/main/analysis/documentAnalysis.js',
    literals: ["'Analyzing document file'"],
    context: 'DocumentAnalysis'
  },
  'image-analyzing': {
    file: 'src/main/analysis/imageAnalysis.js',
    literals: ['`Analyzing image file`'],
    context: 'ImageAnalysis'
  },
  'document-analyzed': {
    file: 'src/main/analysis/documentAnalysis.js',
    literals: ['`[AI-ANALYSIS-SUCCESS] Document analyzed`'],
    context: 'DocumentAnalysis'
  },
  'image-analyzed': {
    file: 'src/main/analysis/imageAnalysis.js',
    literals: ["'[AI-ANALYSIS-SUCCESS] Image analyzed'"],
    context: 'ImageAnalysis'
  },
  'image-folder-suggestion': {
    file: 'src/main/analysis/imageAnalysis.js',
    literals: ["'[ImageAnalysis] Surfaced new-folder suggestion'"],
    context: 'ImageAnalysis'
  },
  'document-folder-suggestion': {
    file: 'src/main/analysis/modelAnalysisResult.js',
    literals: ["'[DocumentLLM] Surfaced new-folder suggestion'"],
    context: null
  },
  'matcher-folder-suggestion': {
    file: 'src/main/analysis/semanticFolderMatcher.js',
    literals: ["'[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion'"],
    context: 'SemanticFolderMatcher'
  },
  'folder-fallback': {
    file: 'src/main/services/FolderMatchingService.js',
    literals: [
      "'[FolderMatching] No match across exact/canonical/levenshtein/prefix/token/description; using fallback'"
    ],
    context: 'FolderMatchingService'
  },
  'vision-starting': {
    file: 'src/main/services/VisionService.js',
    literals: ["'[VisionService] Starting vision runtime'"],
    context: 'VisionService'
  },
  'vision-ready': {
    file: 'src/main/services/VisionService.js',
    literals: ["'[VisionService] Vision runtime ready'"],
    context: 'VisionService'
  },
  'vision-stopping': {
    file: 'src/main/services/VisionService.js',
    literals: ["'[VisionService] Shutting down vision runtime'"],
    context: 'VisionService'
  },
  'vision-batch-entered': {
    file: 'src/main/services/LlamaService.js',
    literals: ["'[LlamaService] Entered vision batch mode'"],
    context: 'LlamaService'
  },
  'vision-batch-exited': {
    file: 'src/main/services/LlamaService.js',
    literals: ["'[LlamaService] Exited vision batch mode'"],
    context: 'LlamaService'
  },
  'model-loading': {
    file: 'src/main/services/LlamaService.js',
    literals: ['`[LlamaService] Loading $' + '{type} model: $' + '{modelName}`'],
    context: 'LlamaService'
  },
  'model-loaded': {
    file: 'src/main/services/ModelMemoryManager.js',
    literals: ["'[Memory] Model loaded'"],
    context: 'ModelMemoryManager'
  },
  'model-unloading': {
    file: 'src/main/services/ModelMemoryManager.js',
    literals: ["'[Memory] Unloading model'"],
    context: 'ModelMemoryManager'
  },
  'embedding-unloaded-for-vision': {
    file: 'src/main/services/LlamaService.js',
    literals: ["'[LlamaService] Unloaded the CPU embedding model from the vision batch'"],
    context: 'LlamaService'
  },
  'embeddings-flushed': {
    file: 'src/main/analysis/embeddingQueue/EmbeddingQueueCore.js',
    literals: ["'[EmbeddingQueue] Successfully flushed batch'"],
    context: 'EmbeddingQueue'
  },
  'index-saved': {
    file: 'src/main/services/OramaVectorService.js',
    literals: ["'[OramaVectorService] Persisted databases'"],
    context: 'OramaVectorService'
  },
  'storage-full': {
    file: 'src/main/services/DegradedStateTracker.js',
    literals: ["'[DegradedState] flag raised'"],
    context: 'DegradedStateTracker'
  },
  'degraded-raised': {
    file: 'src/main/services/DegradedStateTracker.js',
    literals: ["'[DegradedState] flag raised'"],
    context: 'DegradedStateTracker'
  },
  'storage-cleared': {
    file: 'src/main/services/DegradedStateTracker.js',
    literals: ["'[DegradedState] flag cleared'"],
    context: 'DegradedStateTracker'
  },
  'organize-batch-start': {
    file: 'src/main/ipc/files/batchOrganizeHandler.js',
    literals: [
      '`[FILE-OPS] Starting batch operation $' + '{batchId} with $' + '{totalOperations} files`'
    ],
    context: null
  },
  'organize-move': {
    file: 'src/main/ipc/files/batchOrganizeHandler.js',
    literals: ["'[FILE-OPS] Move completed'"],
    context: null
  },
  'organize-skipped': {
    file: 'src/main/ipc/files/batchOrganizeHandler.js',
    literals: ["'[FILE-OPS] Move skipped (duplicate)'"],
    context: null
  },
  'organize-paused': {
    file: 'src/main/ipc/files/batchOrganizeHandler.js',
    literals: ["'[FILE-OPS] Batch paused by user'"],
    context: null
  },
  'auto-organize-file': {
    file: 'src/main/services/autoOrganize/fileProcessor.js',
    literals: ["'[AutoOrganize] Auto-organizing new file'"],
    context: 'AutoOrganize-FileProcessor'
  },
  'auto-organize-held': {
    file: 'src/main/services/autoOrganize/fileProcessor.js',
    literals: ["'[AutoOrganize] Holding file for review (not moved)'"],
    context: 'AutoOrganize-FileProcessor'
  },
  'auto-organize-complete': {
    file: 'src/main/services/autoOrganize/AutoOrganizeServiceCore.js',
    literals: ["'[AutoOrganize] Organization complete'"],
    context: 'AutoOrganizeService'
  },
  'undo-restore': {
    file: 'src/main/services/UndoRedoService.js',
    literals: ["'[UndoRedoService] Restoring file from backup'"],
    context: 'UndoRedoService'
  },
  'download-organized': {
    file: 'src/main/services/DownloadWatcher.js',
    literals: [
      "'[DOWNLOAD-WATCHER] Auto-organized with'",
      '`$' + '{displayConfidencePercent}% confidence:`'
    ],
    context: 'DownloadWatcher'
  },
  'download-renamed': {
    file: 'src/main/services/DownloadWatcher.js',
    literals: ["'[DOWNLOAD-WATCHER] Moved (fallback, renamed due to conflict)'"],
    context: 'DownloadWatcher'
  },
  'download-left': {
    file: 'src/main/services/DownloadWatcher.js',
    literals: ["'[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)'"],
    context: 'DownloadWatcher'
  },
  'download-held': {
    file: 'src/main/services/DownloadWatcher.js',
    literals: ["'[DOWNLOAD-WATCHER] Disk full; holding new download'"],
    context: 'DownloadWatcher'
  },
  'download-resumed': {
    file: 'src/main/services/DownloadWatcher.js',
    literals: ["'[DOWNLOAD-WATCHER] Disk has room again; processing held downloads'"],
    context: 'DownloadWatcher'
  },
  'search-building': {
    file: 'src/main/services/SearchService.js',
    literals: ["'[SearchService] Building BM25 index...'"],
    context: 'SearchService'
  },
  'search-built': {
    file: 'src/main/services/SearchService.js',
    literals: ['`[SearchService] BM25 index built with $' + '{this.documentMap.size} documents`'],
    context: 'SearchService'
  },
  'knowledge-repair': {
    file: 'src/main/services/embedding/knowledgeRepair.js',
    literals: ["'Startup knowledge repair complete'"],
    context: 'KnowledgeRepair'
  }
};

describe('every rule is tied to a real log line', () => {
  const REPO_ROOT = path.join(__dirname, '..', '..', '..');
  /** @type {Map<string, string>} */
  const sourceText = new Map();
  const read = (file) => {
    if (!sourceText.has(file)) {
      sourceText.set(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    }
    return sourceText.get(file);
  };

  test('every rule id has a source entry, and no entry names a missing rule', () => {
    expect(Object.keys(SOURCES).sort()).toEqual([...ACTIVITY_RULE_IDS].sort());
  });

  test.each(Object.entries(SOURCES))('%s: the source still writes this line', (_id, source) => {
    const text = read(source.file);
    for (const literal of source.literals) {
      expect(text).toContain(literal);
    }
  });

  test.each(Object.entries(SOURCES).filter(([, source]) => source.context))(
    '%s: the source file logs under the trusted context',
    (_id, source) => {
      expect(read(source.file)).toContain(`createLogger('${source.context}')`);
    }
  );

  test('table cases use the context their source logs under', () => {
    for (const { rule, record } of CASES) {
      const { context } = SOURCES[rule];
      if (context) expect({ rule, context: record.context }).toEqual({ rule, context });
    }
  });
});

describe('activityFromLogRecord', () => {
  test.each(CASES)('$rule → "$expected.text"', ({ record, expected }) => {
    expect(activityFromLogRecord(record)).toEqual(expected);
  });

  test.each(CASES)('$rule: the activity fits the live-log batch schema', ({ record }) => {
    const activity = activityFromLogRecord(record);
    expect(activity).not.toBeNull();
    expect(batchSchemaIssues(activity)).toEqual([]);
  });

  test('the table covers every rule id', () => {
    expect(new Set(CASES.map((c) => c.rule))).toEqual(new Set(ACTIVITY_RULE_IDS));
  });

  test('the rule id list cannot be changed by a caller', () => {
    expect(Object.isFrozen(ACTIVITY_RULE_IDS)).toBe(true);
  });

  test('a known message from the wrong logger context is not trusted', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SomethingElse',
        msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
        data: { filePath: '[REDACTED_PATH]\\x.pdf' }
      })
    ).toBeNull();
  });

  test('the watcher\'s own "Analyzing file:" line is not an activity', () => {
    // The analyzers announce the same file ("Analyzing X").
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SmartFolderWatcher',
        msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\lease.pdf'
      })
    ).toBeNull();
  });

  test('watcher completion reads "Analyzed X" for every file type, cache hits included', () => {
    const watcher = (msg) =>
      activityFromLogRecord({ level: 'info', context: 'SmartFolderWatcher', msg });
    for (const name of ['lease.pdf', 'notes.txt', 'receipt-0412.jpg', 'clip.MP4', 'a.unknownext']) {
      expect(watcher(`[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]\\${name}`)).toEqual(
        {
          kind: 'analyzed',
          icon: 'check',
          tone: 'success',
          text: `Analyzed ${name}`,
          file: name
        }
      );
    }
    expect(watcher('[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]')).toEqual({
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed a file'
    });
  });

  test.each([
    ['DocumentAnalysis', '[AI-ANALYSIS-SUCCESS] Document analyzed', 'Q3 budget (final).xlsx'],
    ['ImageAnalysis', '[AI-ANALYSIS-SUCCESS] Image analyzed', 'IMG_2041.HEIC']
  ])(
    '%s success and watcher completion share kind and file, so the feed can merge them',
    (context, msg, name) => {
      const analyzer = activityFromLogRecord({
        level: 'info',
        context,
        msg,
        data: { fileName: name, category: 'Finance' }
      });
      const watcher = activityFromLogRecord({
        level: 'info',
        context: 'SmartFolderWatcher',
        msg: `[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]\\${name}`
      });
      expect(analyzer.text).toBe(`Analyzed ${name} → Finance`);
      expect(watcher.text).toBe(`Analyzed ${name}`);
      expect({ kind: watcher.kind, file: watcher.file }).toEqual({
        kind: analyzer.kind,
        file: analyzer.file
      });
      expect(analyzer.file).toBe(name);
    }
  );

  test('a file field without a usable name reads "a file"', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SmartFolderWatcher',
        msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
        data: { filePath: '[REDACTED_PATH]' }
      })
    ).toEqual({
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Queued a file for analysis'
    });
  });

  test('any unmatched warning becomes a Problem line without its [TAG]', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'DownloadWatcher',
        msg: '[DOWNLOAD-WATCHER] Cannot access file:',
        data: { code: 'EBUSY' }
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: 'Problem: Cannot access file:'
    });
  });

  test('unmatched errors and fatals become error-toned Problem lines', () => {
    expect(
      activityFromLogRecord({
        level: 'error',
        context: 'OramaVectorService',
        msg: '[OramaVectorService] Persist failed: ENOSPC'
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'error',
      text: 'Problem: Persist failed: ENOSPC'
    });
    expect(
      activityFromLogRecord({ level: 'fatal', context: 'App', msg: 'Renderer crashed' })
    ).toEqual({ kind: 'problem', icon: 'alert', tone: 'error', text: 'Problem: Renderer crashed' });
  });

  test('a Problem line with nothing left after its [TAG] reads "Something went wrong"', () => {
    for (const msg of ['[OramaVectorService]', '[X]   ', '   ', '']) {
      expect(activityFromLogRecord({ level: 'error', context: 'X', msg })).toEqual({
        kind: 'problem',
        icon: 'alert',
        tone: 'error',
        text: 'Problem: Something went wrong'
      });
    }
  });

  test('a Problem line shows file names without the redacted-path token and names the file', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'DownloadWatcher',
        msg: '[DOWNLOAD-WATCHER] Could not move [REDACTED_PATH]\\statement.pdf: EBUSY'
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: 'Problem: Could not move statement.pdf: EBUSY',
      file: 'statement.pdf',
      files: ['statement.pdf']
    });
    expect(
      activityFromLogRecord({
        level: 'error',
        context: 'X',
        msg: 'Copy [REDACTED_PATH]/a.txt => [REDACTED_PATH]/b.txt failed'
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'error',
      text: 'Problem: Copy a.txt => b.txt failed',
      file: 'a.txt',
      files: ['a.txt', 'b.txt failed']
    });
  });

  test.each([
    // Windows: the logger keeps spaces and brackets in a name, so the whole
    // name is the file (redact mode must hide all of it, not just "My").
    ['[REDACTED_PATH]\\My Invoice 2024.pdf', 'My Invoice 2024.pdf', 'Problem: My Invoice 2024.pdf'],
    ["[REDACTED_PATH]\\it's (copy).pdf", "it's (copy).pdf", "Problem: it's (copy).pdf"],
    // Over-capturing trailing words is accepted: it errs toward hiding.
    [
      'Cannot read [REDACTED_PATH]\\My Invoice.pdf failed',
      'My Invoice.pdf failed',
      'Problem: Cannot read My Invoice.pdf failed'
    ],
    // After `/` the name is read the same way: a forward-slash drive path
    // (C:/Users/...) keeps its spaces, so a POSIX name (which the logger cuts
    // at whitespace) errs toward hiding the words after it.
    [
      'Cannot read [REDACTED_PATH]/notes.txt because it is locked',
      'notes.txt because it is locked',
      'Problem: Cannot read notes.txt because it is locked'
    ],
    [
      'open [REDACTED_PATH]/report [final] (2).pdf',
      'report [final] (2).pdf',
      'Problem: open report [final] (2).pdf'
    ],
    // JSON-escaped Windows separator.
    [
      String.raw`payload {"from":"[REDACTED_PATH]\\Lab results.pdf"}`,
      'Lab results.pdf',
      'Problem: payload {"from":"Lab results.pdf"}'
    ]
  ])('a redacted path in %j names the file %j', (msg, file, text) => {
    expect(activityFromLogRecord({ level: 'warn', context: 'X', msg })).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text,
      file,
      files: [file]
    });
  });

  test.each([
    ['a name longer than 120 characters', `${'long-name-'.repeat(15)}.pdf`],
    ['a name ending in a bracket', 'Report (final)'],
    ['a name with spaces', 'My Invoice 2024.pdf']
  ])('a Problem line names %s exactly as its text shows it', (_label, name) => {
    // Redact mode hides `file` by substring: a shortened or trimmed name
    // would leave the rest of it visible.
    const result = activityFromLogRecord({
      level: 'warn',
      context: 'X',
      msg: `Cannot read [REDACTED_PATH]\\${name}`
    });
    expect(result.file).toBe(name);
    expect(result.text.includes(result.file)).toBe(true);
  });

  test('a Problem line lists every file name, the first also as file', () => {
    const result = activityFromLogRecord({
      level: 'error',
      context: 'FileOps',
      msg: String.raw`Failed to move [REDACTED_PATH]\alpha secret.pdf to [REDACTED_PATH]\beta secret.pdf: EBUSY`
    });
    expect(result.text).toBe('Problem: Failed to move alpha secret.pdf to beta secret.pdf: EBUSY');
    // Windows names keep their spaces, so "to" is over-captured into the
    // first name; the name stops before the next token.
    expect(result.file).toBe('alpha secret.pdf to');
    expect(result.files).toEqual(['alpha secret.pdf to', 'beta secret.pdf']);
    for (const name of result.files) expect(result.text.includes(name)).toBe(true);
  });

  test('Problem names are trimmed, deduped, capped, and cover every separator form', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'X',
        msg: String.raw`Copy [REDACTED_PATH]\a.pdf, [REDACTED_PATH]/b.pdf; [REDACTED_PATH]\\c.pdf and [REDACTED_PATH]\a.pdf.`
      }).files
    ).toEqual(['a.pdf', 'b.pdf', 'c.pdf and']);
    const many = Array.from({ length: 12 }, (_, i) => `[REDACTED_PATH]\\f${i}.txt`).join(' => ');
    const result = activityFromLogRecord({ level: 'warn', context: 'X', msg: `Lost ${many}` });
    expect(result.files).toHaveLength(8);
    expect(result.files[0]).toBe('f0.txt');
    expect(result.file).toBe('f0.txt');
  });

  test('a quote ends a Windows name but not a name after "/"', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'X',
        msg: String.raw`Open "[REDACTED_PATH]\a b.pdf" now`
      }).files
    ).toEqual(['a b.pdf']);
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'X',
        msg: 'Open [REDACTED_PATH]/my"file.pdf'
      }).files
    ).toEqual(['my"file.pdf']);
  });

  test('a bare redacted-path token is removed from Problem text', () => {
    expect(
      activityFromLogRecord({ level: 'error', context: 'X', msg: 'Cannot open [REDACTED_PATH]' })
    ).toEqual({ kind: 'problem', icon: 'alert', tone: 'error', text: 'Problem: Cannot open' });
    expect(activityFromLogRecord({ level: 'error', context: 'X', msg: '[REDACTED_PATH]' })).toEqual(
      {
        kind: 'problem',
        icon: 'alert',
        tone: 'error',
        text: 'Problem: Something went wrong'
      }
    );
  });

  test('a leading redacted path is part of the message, not a [TAG] to strip', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'X',
        msg: '[REDACTED_PATH]/scan.pdf could not be read'
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: 'Problem: scan.pdf could not be read',
      file: 'scan.pdf could not be read',
      files: ['scan.pdf could not be read']
    });
  });

  test('a degraded-state message gets the same redacted-path cleanup', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'DegradedStateTracker',
        msg: '[DegradedState] flag raised',
        data: { code: 'x.y', severity: 'error', message: 'Cannot open [REDACTED_PATH]/index.db' }
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'error',
      text: 'Problem: Cannot open index.db',
      file: 'index.db',
      files: ['index.db']
    });
  });

  test('a degraded-state message is cut to the message cap before it becomes a Problem line', () => {
    const result = activityFromLogRecord({
      level: 'warn',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag raised',
      data: { code: 'x.y', message: `Cannot open [REDACTED_PATH]\\${'d'.repeat(3000)}` }
    });
    expect(result.kind).toBe('problem');
    expect(result.file.length).toBeGreaterThan(1000);
    expect(result.file.length).toBeLessThanOrEqual(2000);
    expect(batchSchemaIssues(result)).toEqual([]);
  });

  test('a cleared flag other than storage.full is not an activity', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'DegradedStateTracker',
        msg: '[DegradedState] flag cleared',
        data: { code: 'system.metrics-collection-failed' }
      })
    ).toBeNull();
  });

  test('unknown info and debug records are not activities', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'LlamaService',
        msg: '[LlamaService] Model configuration updated'
      })
    ).toBeNull();
    expect(activityFromLogRecord({ level: 'debug', context: 'X', msg: 'detail' })).toBeNull();
  });

  test('malformed input returns null instead of throwing', () => {
    expect(activityFromLogRecord(null)).toBeNull();
    expect(activityFromLogRecord({ level: 'info' })).toBeNull();
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'OramaVectorService',
        msg: '[OramaVectorService] Persisted databases',
        data: { collections: 'not-an-array' }
      })
    ).toEqual({ kind: 'index-saved', icon: 'save', tone: 'success', text: 'Saved search index' });
  });

  test('very long text is clipped to 300 characters', () => {
    const result = activityFromLogRecord({ level: 'error', context: 'X', msg: 'y'.repeat(1000) });
    expect(result.text).toHaveLength(300);
    expect(result.text.endsWith('…')).toBe(true);
  });
});
