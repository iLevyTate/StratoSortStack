/**
 * Validation Schemas Tests
 *
 * Tests both Zod-based and fallback validation paths to ensure
 * security-critical input validation works correctly.
 *
 * Coverage target: main/ipc/validationSchemas.js (was 32% stmts, 0.7% branches)
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

describe('validationSchemas (Zod path)', () => {
  let schemas;

  beforeAll(() => {
    jest.resetModules();
    const mod = require('../src/main/ipc/validationSchemas');
    schemas = mod.schemas;
  });

  describe('filePath schema', () => {
    test('accepts valid file path', () => {
      const result = schemas.filePath.safeParse('/home/user/doc.pdf');
      expect(result.success).toBe(true);
    });

    test('rejects empty string', () => {
      const result = schemas.filePath.safeParse('');
      expect(result.success).toBe(false);
    });

    test('rejects non-string types', () => {
      expect(schemas.filePath.safeParse(123).success).toBe(false);
      expect(schemas.filePath.safeParse(null).success).toBe(false);
      expect(schemas.filePath.safeParse(undefined).success).toBe(false);
    });
  });

  describe('settings schema', () => {
    test('accepts valid partial settings', () => {
      const result = schemas.settings.safeParse({
        textModel: 'llama-3.2-1b.gguf',
        autoOrganize: true,
        maxConcurrentAnalysis: 4
      });
      expect(result.success).toBe(true);
    });

    test('accepts empty settings object', () => {
      const result = schemas.settings.safeParse({});
      expect(result.success).toBe(true);
    });

    test('rejects invalid maxConcurrentAnalysis (below min)', () => {
      const result = schemas.settings.safeParse({ maxConcurrentAnalysis: 0 });
      expect(result.success).toBe(false);
    });

    test('accepts model names with spaces used by local GGUF files', () => {
      const result = schemas.settings.safeParse({ textModel: 'Qwen2.5 7B Instruct (Q4_K_M).gguf' });
      expect(result.success).toBe(true);
    });

    test('rejects model name with shell metacharacters', () => {
      expect(schemas.settings.safeParse({ textModel: 'model;rm -rf /' }).success).toBe(false);
      expect(schemas.settings.safeParse({ textModel: 'model$(evil)' }).success).toBe(false);
    });

    test('rejects model name exceeding max length', () => {
      const result = schemas.settings.safeParse({ textModel: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });

    test('rejects non-boolean for boolean fields', () => {
      const result = schemas.settings.safeParse({ autoOrganize: 'yes' });
      expect(result.success).toBe(false);
    });

    test('accepts valid embedding timing values', () => {
      for (const val of ['during_analysis', 'after_organize', 'manual']) {
        const result = schemas.settings.safeParse({ embeddingTiming: val });
        expect(result.success).toBe(true);
      }
    });

    test('rejects invalid embedding timing', () => {
      const result = schemas.settings.safeParse({ embeddingTiming: 'always' });
      expect(result.success).toBe(false);
    });

    test('accepts valid confidenceThreshold range', () => {
      expect(schemas.settings.safeParse({ confidenceThreshold: 0 }).success).toBe(true);
      expect(schemas.settings.safeParse({ confidenceThreshold: 0.5 }).success).toBe(true);
      expect(schemas.settings.safeParse({ confidenceThreshold: 1 }).success).toBe(true);
    });

    test('rejects confidenceThreshold out of range', () => {
      expect(schemas.settings.safeParse({ confidenceThreshold: -0.1 }).success).toBe(false);
      expect(schemas.settings.safeParse({ confidenceThreshold: 1.1 }).success).toBe(false);
    });

    test('accepts nullish values for optional fields', () => {
      const result = schemas.settings.safeParse({
        textModel: null,
        autoOrganize: null,
        maxConcurrentAnalysis: null
      });
      expect(result.success).toBe(true);
    });
  });

  describe('smartFolder schema', () => {
    test('accepts valid smart folder', () => {
      const result = schemas.smartFolder.safeParse({
        name: 'Invoices',
        path: '/home/user/invoices'
      });
      expect(result.success).toBe(true);
    });

    test('accepts smart folder with optional fields', () => {
      const result = schemas.smartFolder.safeParse({
        name: 'Invoices',
        path: '/home/user/invoices',
        description: 'Financial documents',
        keywords: ['invoice', 'receipt'],
        category: 'finance',
        isDefault: false
      });
      expect(result.success).toBe(true);
    });

    test('rejects missing name', () => {
      const result = schemas.smartFolder.safeParse({ path: '/home' });
      expect(result.success).toBe(false);
    });

    test('rejects missing path', () => {
      const result = schemas.smartFolder.safeParse({ name: 'Test' });
      expect(result.success).toBe(false);
    });

    test('rejects empty name', () => {
      const result = schemas.smartFolder.safeParse({ name: '', path: '/home' });
      expect(result.success).toBe(false);
    });
  });

  describe('batchOrganize schema', () => {
    test('accepts valid batch operations', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: '/a/file.txt', destination: '/b/file.txt' }]
      });
      expect(result.success).toBe(true);
    });

    test('rejects empty operations array', () => {
      const result = schemas.batchOrganize.safeParse({ operations: [] });
      expect(result.success).toBe(false);
    });

    test('rejects operations with empty source', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: '', destination: '/b/file.txt' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects too many operations (>1000)', () => {
      const ops = Array.from({ length: 1001 }, (_, i) => ({
        source: `/a/file${i}.txt`,
        destination: `/b/file${i}.txt`
      }));
      const result = schemas.batchOrganize.safeParse({ operations: ops });
      expect(result.success).toBe(false);
    });
  });

  describe('searchQuery schema', () => {
    test('accepts valid search query', () => {
      const result = schemas.searchQuery.safeParse({ query: 'test', limit: 10 });
      expect(result.success).toBe(true);
    });

    test('accepts empty search (no query)', () => {
      const result = schemas.searchQuery.safeParse({});
      expect(result.success).toBe(true);
    });

    test('rejects limit above 1000', () => {
      const result = schemas.searchQuery.safeParse({ limit: 1001 });
      expect(result.success).toBe(false);
    });

    test('rejects negative offset', () => {
      const result = schemas.searchQuery.safeParse({ offset: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('semanticSearch schema', () => {
    test('accepts valid semantic search', () => {
      const result = schemas.semanticSearch.safeParse({
        query: 'find similar documents',
        topK: 10,
        mode: 'hybrid'
      });
      expect(result.success).toBe(true);
    });

    test('rejects query shorter than 2 chars', () => {
      const result = schemas.semanticSearch.safeParse({ query: 'a' });
      expect(result.success).toBe(false);
    });

    test('rejects query longer than 2000 chars', () => {
      const result = schemas.semanticSearch.safeParse({ query: 'x'.repeat(2001) });
      expect(result.success).toBe(false);
    });

    test('accepts valid modes', () => {
      for (const mode of ['hybrid', 'vector', 'bm25']) {
        expect(schemas.semanticSearch.safeParse({ query: 'test', mode }).success).toBe(true);
      }
    });

    test('rejects invalid mode', () => {
      const result = schemas.semanticSearch.safeParse({ query: 'test', mode: 'turbo' });
      expect(result.success).toBe(false);
    });

    test('rejects topK above MAX_TOP_K (Atlas previously sent 200)', () => {
      expect(schemas.semanticSearch.safeParse({ query: 'device', topK: 200 }).success).toBe(false);
      expect(schemas.semanticSearch.safeParse({ query: 'device', topK: 100 }).success).toBe(true);
    });
  });

  describe('chatQuery schema', () => {
    test('accepts valid chat query', () => {
      const result = schemas.chatQuery.safeParse({
        query: 'What is this document about?',
        topK: 6,
        mode: 'hybrid'
      });
      expect(result.success).toBe(true);
    });

    test('accepts chat query with document scope', () => {
      const result = schemas.chatQuery.safeParse({
        query: 'Summarize this file',
        documentScopeItems: [{ id: 'file-1', path: '/docs/test.pdf', name: 'test.pdf' }],
        strictScope: true
      });
      expect(result.success).toBe(true);
    });

    test('rejects query under 2 chars', () => {
      expect(schemas.chatQuery.safeParse({ query: 'x' }).success).toBe(false);
    });

    test('accepts responseMode values', () => {
      expect(schemas.chatQuery.safeParse({ query: 'test', responseMode: 'fast' }).success).toBe(
        true
      );
      expect(schemas.chatQuery.safeParse({ query: 'test', responseMode: 'deep' }).success).toBe(
        true
      );
    });
  });

  describe('findDuplicates schema', () => {
    test('accepts default parameters', () => {
      const result = schemas.findDuplicates.safeParse({});
      expect(result.success).toBe(true);
    });

    test('rejects threshold below 0.7', () => {
      const result = schemas.findDuplicates.safeParse({ threshold: 0.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('fileOperation schema', () => {
    test('accepts valid move operation', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'move',
        source: '/a/file.txt',
        destination: '/b/file.txt'
      });
      expect(result.success).toBe(true);
    });

    test('rejects invalid operation type', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'hack',
        source: '/a/file.txt'
      });
      expect(result.success).toBe(false);
    });

    test('batch_organize requires operations array', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize'
      });
      expect(result.success).toBe(false);
    });

    test('batch_organize rejects empty operations', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        operations: []
      });
      expect(result.success).toBe(false);
    });

    // Same stripping risk as dryRun: without the per-op `suggestion` in the
    // schema, batch organize never learns which folder the app suggested and
    // cannot record the user's override as a correction.
    test('preserves the per-op suggestion on a batch_organize payload', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        operations: [
          {
            source: '/a/file.txt',
            destination: '/b/Finance/file.txt',
            type: 'move',
            suggestion: { folder: 'Receipts', path: '/b/Receipts', source: 'engine' }
          }
        ]
      });
      expect(result.success).toBe(true);
      expect(result.data.operations[0].suggestion).toEqual({
        folder: 'Receipts',
        path: '/b/Receipts',
        source: 'engine'
      });
    });

    test('rejects a suggestion with a relative path', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        operations: [
          {
            source: '/a/file.txt',
            destination: '/b/file.txt',
            suggestion: { folder: 'Receipts', path: '../Receipts' }
          }
        ]
      });
      expect(result.success).toBe(false);
    });

    // Regression guard: prior to this fix, Zod's default object mode silently
    // stripped `dryRun` from the parsed payload. The handler then never saw
    // the flag and executed a real batch when the renderer expected a preview.
    // See the `if (operation?.dryRun === true)` branch in batchOrganizeHandler.js
    // for the consumer.
    test('preserves dryRun=true on a batch_organize payload', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        dryRun: true,
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(true);
      expect(result.data.dryRun).toBe(true);
    });

    test('preserves strict=true on a batch_organize payload', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        strict: true,
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(true);
      expect(result.data.strict).toBe(true);
    });

    test('preserves the label on a batch_move payload', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_move',
        label: 'Move 2 files to Taxes',
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(true);
      expect(result.data.label).toBe('Move 2 files to Taxes');
    });

    test('refuses a label longer than 120 characters', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_move',
        label: 'x'.repeat(121),
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    test('coerces invalid dryRun shapes to validation failure', () => {
      const result = schemas.fileOperation.safeParse({
        type: 'batch_organize',
        dryRun: 'yes',
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    // ===== IPC-gate path hardening (audit item #1) =====
    // Defense-in-depth: validateFileOperationPath in batchOrganizeHandler.js is
    // the canonical guard, but the IPC schema should fail-fast at the boundary so
    // a 100KB string, a URL, or a traversal payload never reaches the handler.
    describe('IPC-gate path hardening', () => {
      describe('top-level source/destination', () => {
        test('rejects path traversal in source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: '/a/../../etc/passwd',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects path traversal in destination', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: '/a/file.txt',
            destination: '/b/../../etc/shadow'
          });
          expect(result.success).toBe(false);
        });

        test('rejects URL-like source (file://)', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: 'file:///etc/passwd',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects URL-like source (http://)', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: 'http://evil.example.com/payload',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects UNC source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: '\\\\server\\share\\file.txt',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects relative source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: 'relative/file.txt',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects over-long source (>2048 chars)', () => {
          const longPath = '/' + 'a'.repeat(2050);
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: longPath,
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('rejects empty source when provided', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: '',
            destination: '/b/file.txt'
          });
          expect(result.success).toBe(false);
        });

        test('accepts valid absolute POSIX source/destination', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: '/in/a.pdf',
            destination: '/out/a.pdf'
          });
          expect(result.success).toBe(true);
        });

        test('accepts valid absolute Windows source/destination', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'move',
            source: 'C:\\Users\\alice\\a.pdf',
            destination: 'D:\\out\\a.pdf'
          });
          expect(result.success).toBe(true);
        });

        test('allows missing source/destination on batch_organize (operations[] carries the paths)', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
          });
          expect(result.success).toBe(true);
        });
      });

      describe('operations[] entries', () => {
        test('rejects traversal inside operations[].source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: '/in/../../etc/passwd', destination: '/out/a.pdf' }]
          });
          expect(result.success).toBe(false);
        });

        test('rejects traversal inside operations[].destination', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: '/in/a.pdf', destination: '/out/../../etc/shadow' }]
          });
          expect(result.success).toBe(false);
        });

        test('rejects URL-like operations[].source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: 'file:///etc/passwd', destination: '/out/a.pdf' }]
          });
          expect(result.success).toBe(false);
        });

        test('rejects UNC operations[].destination', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: '/in/a.pdf', destination: '\\\\server\\share\\a.pdf' }]
          });
          expect(result.success).toBe(false);
        });

        test('rejects relative operations[].source', () => {
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: 'relative/file.txt', destination: '/out/a.pdf' }]
          });
          expect(result.success).toBe(false);
        });

        test('rejects over-long operations[].source (>2048 chars)', () => {
          const longPath = '/' + 'a'.repeat(2050);
          const result = schemas.fileOperation.safeParse({
            type: 'batch_organize',
            operations: [{ source: longPath, destination: '/out/a.pdf' }]
          });
          expect(result.success).toBe(false);
        });
      });
    });
  });

  describe('batchOrganize schema — IPC-gate path hardening (audit item #1)', () => {
    test('rejects traversal in operations[].source', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: '/in/../../etc/passwd', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects URL-like operations[].source', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: 'file:///etc/passwd', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects UNC operations[].destination', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: '/in/a.pdf', destination: '\\\\server\\share\\a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects relative operations[].source', () => {
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: 'relative/file.txt', destination: '/out/a.pdf' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects over-long operations[].destination (>2048 chars)', () => {
      const longPath = '/' + 'a'.repeat(2050);
      const result = schemas.batchOrganize.safeParse({
        operations: [{ source: '/in/a.pdf', destination: longPath }]
      });
      expect(result.success).toBe(false);
    });
  });

  describe('smartFolderEdit schema', () => {
    test('accepts valid edit tuple', () => {
      const result = schemas.smartFolderEdit.safeParse(['folder-id-1', { name: 'Updated Name' }]);
      expect(result.success).toBe(true);
    });

    test('rejects empty folder ID', () => {
      const result = schemas.smartFolderEdit.safeParse(['', { name: 'Test' }]);
      expect(result.success).toBe(false);
    });
  });

  describe('scoreFiles schema', () => {
    test('accepts valid input', () => {
      const result = schemas.scoreFiles.safeParse({
        query: 'test query',
        fileIds: ['file-1', 'file-2']
      });
      expect(result.success).toBe(true);
    });

    test('rejects empty fileIds', () => {
      const result = schemas.scoreFiles.safeParse({
        query: 'test',
        fileIds: []
      });
      expect(result.success).toBe(false);
    });
  });

  describe('computeClusters schema', () => {
    test('accepts auto k', () => {
      const result = schemas.computeClusters.safeParse({ k: 'auto' });
      expect(result.success).toBe(true);
      expect(result.data.generateLabels).toBe(false);
    });

    test('accepts numeric k', () => {
      const result = schemas.computeClusters.safeParse({ k: 5 });
      expect(result.success).toBe(true);
    });

    test('accepts empty object (defaults)', () => {
      const result = schemas.computeClusters.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.generateLabels).toBe(false);
      expect(result.data.k).toBe('auto');
    });

    test('accepts explicit generateLabels true', () => {
      const result = schemas.computeClusters.safeParse({ k: 'auto', generateLabels: true });
      expect(result.success).toBe(true);
      expect(result.data.generateLabels).toBe(true);
    });
  });

  describe('feedback schemas', () => {
    test('feedbackMemoryAdd accepts valid input', () => {
      const result = schemas.feedbackMemoryAdd.safeParse({
        text: 'Always put invoices in Finance folder'
      });
      expect(result.success).toBe(true);
    });

    test('feedbackMemoryAdd rejects too short text', () => {
      const result = schemas.feedbackMemoryAdd.safeParse({ text: 'x' });
      expect(result.success).toBe(false);
    });

    test('feedbackMemoryDelete accepts valid id', () => {
      const result = schemas.feedbackMemoryDelete.safeParse({ id: 'mem-1' });
      expect(result.success).toBe(true);
    });

    test('feedbackMemoryUpdate accepts valid update', () => {
      const result = schemas.feedbackMemoryUpdate.safeParse({
        id: 'mem-1',
        text: 'Updated memory text'
      });
      expect(result.success).toBe(true);
    });
  });

  describe('downloadsTriageDeepScan schema', () => {
    test('accepts request with no fileIds (deep-scan everything)', () => {
      const result = schemas.downloadsTriageDeepScan.safeParse({
        triageId: 'triage-123'
      });
      expect(result.success).toBe(true);
    });

    test('accepts request with empty fileIds (same intent: scan everything)', () => {
      // Regression: previously the schema had .min(1) on fileIds, which forced
      // callers wanting "scan everything" to omit the key entirely. Present-but-
      // empty and absent now both express the same intent.
      const result = schemas.downloadsTriageDeepScan.safeParse({
        triageId: 'triage-123',
        fileIds: []
      });
      expect(result.success).toBe(true);
    });

    test('accepts request with explicit fileIds subset', () => {
      const result = schemas.downloadsTriageDeepScan.safeParse({
        triageId: 'triage-123',
        fileIds: ['/a/file1.pdf', '/a/file2.pdf']
      });
      expect(result.success).toBe(true);
    });

    test('still rejects oversized fileIds (>5000)', () => {
      const fileIds = Array.from({ length: 5001 }, (_, i) => `/a/${i}.pdf`);
      const result = schemas.downloadsTriageDeepScan.safeParse({
        triageId: 'triage-123',
        fileIds
      });
      expect(result.success).toBe(false);
    });
  });

  // M19: the schema is the single source of truth for the seed cap; the
  // handler no longer silently slices to 10.
  describe('embeddingsFindMultiHop schema', () => {
    test('accepts up to 10 seeds unchanged', () => {
      const seedIds = Array.from({ length: 10 }, (_, i) => `seed-${i}`);
      const result = schemas.embeddingsFindMultiHop.safeParse({ seedIds });
      expect(result.success).toBe(true);
      expect(result.data.seedIds).toHaveLength(10);
    });

    test('hard-rejects more than 10 seeds rather than truncating', () => {
      const seedIds = Array.from({ length: 11 }, (_, i) => `seed-${i}`);
      const result = schemas.embeddingsFindMultiHop.safeParse({ seedIds });
      expect(result.success).toBe(false);
    });
  });
});

describe('validationSchemas (fallback path)', () => {
  let fallbackSchemas;

  beforeAll(() => {
    jest.resetModules();
    // Force Zod to be unavailable
    jest.doMock('zod', () => {
      throw new Error('zod not installed');
    });
    const mod = require('../src/main/ipc/validationSchemas');
    fallbackSchemas = mod.schemas;
  });

  afterAll(() => {
    jest.unmock('zod');
  });

  test('uses fallback validators when zod is unavailable', () => {
    const mod = require('../src/main/ipc/validationSchemas');
    expect(mod._usingFallback).toBe(true);
    expect(mod.z).toBeNull();
  });

  describe('filePath fallback', () => {
    test('accepts valid path', () => {
      const result = fallbackSchemas.filePath.safeParse('/home/user/file.txt');
      expect(result.success).toBe(true);
    });

    test('rejects empty string', () => {
      const result = fallbackSchemas.filePath.safeParse('');
      expect(result.success).toBe(false);
    });

    test('rejects non-string', () => {
      const result = fallbackSchemas.filePath.safeParse(123);
      expect(result.success).toBe(false);
    });

    test('parse throws on invalid input', () => {
      expect(() => fallbackSchemas.filePath.parse('')).toThrow();
    });

    test('parse returns valid data', () => {
      expect(fallbackSchemas.filePath.parse('/valid/path')).toBe('/valid/path');
    });
  });

  describe('settings fallback', () => {
    test('accepts valid object', () => {
      const result = fallbackSchemas.settings.safeParse({ textModel: 'test' });
      expect(result.success).toBe(true);
    });

    test('rejects null', () => {
      const result = fallbackSchemas.settings.safeParse(null);
      expect(result.success).toBe(false);
    });

    test('strips __proto__ key for prototype pollution protection', () => {
      const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"safe":"value"}');
      const result = fallbackSchemas.settings.safeParse(malicious);
      expect(result.success).toBe(true);
      // __proto__ should not be an own property on the sanitized data
      expect(Object.getOwnPropertyDescriptor(result.data, '__proto__')).toBeUndefined();
      expect(result.data.safe).toBe('value');
    });

    test('strips constructor and prototype keys', () => {
      const result = fallbackSchemas.settings.safeParse({
        constructor: 'bad',
        prototype: 'bad',
        validKey: 'ok'
      });
      expect(result.success).toBe(true);
      // These dangerous keys should not be own properties
      expect(Object.getOwnPropertyDescriptor(result.data, 'constructor')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(result.data, 'prototype')).toBeUndefined();
      expect(result.data.validKey).toBe('ok');
    });
  });

  describe('smartFolder fallback', () => {
    test('accepts valid smart folder', () => {
      const result = fallbackSchemas.smartFolder.safeParse({
        name: 'Test',
        path: '/test'
      });
      expect(result.success).toBe(true);
    });

    test('rejects missing name', () => {
      const result = fallbackSchemas.smartFolder.safeParse({ path: '/test' });
      expect(result.success).toBe(false);
    });

    test('rejects non-object', () => {
      const result = fallbackSchemas.smartFolder.safeParse('not an object');
      expect(result.success).toBe(false);
    });
  });

  describe('searchQuery fallback', () => {
    test('accepts valid search', () => {
      const result = fallbackSchemas.searchQuery.safeParse({ query: 'test' });
      expect(result.success).toBe(true);
    });

    test('rejects invalid limit', () => {
      const result = fallbackSchemas.searchQuery.safeParse({ limit: 'many' });
      expect(result.success).toBe(false);
    });

    test('rejects limit out of range', () => {
      expect(fallbackSchemas.searchQuery.safeParse({ limit: 0 }).success).toBe(false);
      expect(fallbackSchemas.searchQuery.safeParse({ limit: 1001 }).success).toBe(false);
    });

    test('rejects negative offset', () => {
      const result = fallbackSchemas.searchQuery.safeParse({ offset: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('batchOrganize fallback', () => {
    test('accepts valid batch', () => {
      const result = fallbackSchemas.batchOrganize.safeParse({
        operations: [{ source: '/a', destination: '/b' }]
      });
      expect(result.success).toBe(true);
    });

    test('rejects empty operations', () => {
      const result = fallbackSchemas.batchOrganize.safeParse({ operations: [] });
      expect(result.success).toBe(false);
    });

    test('rejects missing operations', () => {
      const result = fallbackSchemas.batchOrganize.safeParse({});
      expect(result.success).toBe(false);
    });

    test('rejects operation with empty source', () => {
      const result = fallbackSchemas.batchOrganize.safeParse({
        operations: [{ source: '', destination: '/b' }]
      });
      expect(result.success).toBe(false);
    });

    test('rejects oversized batch (>1000)', () => {
      const ops = Array.from({ length: 1001 }, () => ({
        source: '/a',
        destination: '/b'
      }));
      const result = fallbackSchemas.batchOrganize.safeParse({ operations: ops });
      expect(result.success).toBe(false);
    });

    test('rejects non-object operations entries', () => {
      const result = fallbackSchemas.batchOrganize.safeParse({
        operations: ['not', 'objects']
      });
      expect(result.success).toBe(false);
    });
  });

  describe('pagination fallback', () => {
    test('accepts valid pagination', () => {
      const result = fallbackSchemas.pagination.safeParse({ limit: 10, offset: 0 });
      expect(result.success).toBe(true);
    });

    test('rejects non-object', () => {
      const result = fallbackSchemas.pagination.safeParse('nope');
      expect(result.success).toBe(false);
    });
  });
});
