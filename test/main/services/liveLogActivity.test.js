/**
 * Table-driven tests for the Live Activity classifier. Every message below is
 * the real log line as it reaches the logger listener: after util.format and
 * sanitizeLogData, so absolute paths look like `[REDACTED_PATH]\name.ext`.
 */
const {
  activityFromLogRecord,
  ACTIVITY_RULE_IDS
} = require('../../../src/main/services/liveLogActivity');

const CASES = [
  {
    rule: 'watcher-analyzing',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt-0412.jpg',
      data: { applyNaming: true, isContentUpdate: false }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  },
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
      msg: '[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]/notes.txt'
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed notes.txt',
      file: 'notes.txt'
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
    rule: 'index-saved',
    record: {
      level: 'debug',
      context: 'OramaVectorService',
      msg: '[OramaVectorService] Persisted databases',
      data: { collections: ['files', 'chunks'], full: false, durationMs: 18 }
    },
    expected: {
      kind: 'index-saved',
      icon: 'save',
      tone: 'success',
      text: 'Saved search index (files, chunks)'
    }
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
  }
];

describe('activityFromLogRecord', () => {
  test.each(CASES)('$rule → "$expected.text"', ({ record, expected }) => {
    expect(activityFromLogRecord(record)).toEqual(expected);
  });

  test('the table covers every rule id', () => {
    expect(new Set(CASES.map((c) => c.rule))).toEqual(new Set(ACTIVITY_RULE_IDS));
  });

  test('a known message from the wrong logger context is not trusted', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SomethingElse',
        msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\x.pdf'
      })
    ).toBeNull();
  });

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
