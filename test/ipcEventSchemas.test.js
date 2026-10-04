/**
 * Tests for IPC Event Schemas
 * Tests Zod schema validation for IPC event payloads
 */

describe('IPC Event Schemas', () => {
  let schemas;
  let validateEventPayload;
  let hasEventSchema;
  let getEventSchema;
  let EVENT_SCHEMAS;
  let IPC_CHANNELS;

  beforeEach(() => {
    jest.resetModules();
    const module = require('../src/shared/ipcEventSchemas');
    IPC_CHANNELS = require('../src/shared/constants').IPC_CHANNELS;
    schemas = module;
    validateEventPayload = module.validateEventPayload;
    hasEventSchema = module.hasEventSchema;
    getEventSchema = module.getEventSchema;
    EVENT_SCHEMAS = module.EVENT_SCHEMAS;
  });

  describe('Schema exports', () => {
    test('exports all expected schemas', () => {
      expect(schemas.operationProgressSchema).toBeDefined();
      expect(schemas.fileOperationCompleteSchema).toBeDefined();
      expect(schemas.systemMetricsSchema).toBeDefined();
      expect(schemas.notificationSchema).toBeDefined();
      expect(schemas.appErrorSchema).toBeDefined();
      expect(schemas.chatStreamChunkSchema).toBeDefined();
      expect(schemas.chatStreamEndSchema).toBeDefined();
    });

    test('exports EVENT_SCHEMAS map', () => {
      expect(EVENT_SCHEMAS).toBeDefined();
      expect(typeof EVENT_SCHEMAS).toBe('object');
      expect(EVENT_SCHEMAS['operation-progress']).toBeDefined();
      expect(EVENT_SCHEMAS['system-metrics']).toBeDefined();
    });

    test('exports utility functions', () => {
      expect(typeof validateEventPayload).toBe('function');
      expect(typeof hasEventSchema).toBe('function');
      expect(typeof getEventSchema).toBe('function');
    });
  });

  describe('hasEventSchema', () => {
    test('returns true for known channels', () => {
      expect(hasEventSchema('operation-progress')).toBe(true);
      expect(hasEventSchema('system-metrics')).toBe(true);
      expect(hasEventSchema('notification')).toBe(true);
      expect(hasEventSchema('app:error')).toBe(true);
    });

    test('returns false for unknown channels', () => {
      expect(hasEventSchema('unknown-channel')).toBe(false);
      expect(hasEventSchema('')).toBe(false);
      expect(hasEventSchema('random-event')).toBe(false);
    });
  });

  describe('getEventSchema', () => {
    test('returns schema for known channels', () => {
      const progressSchema = getEventSchema('operation-progress');
      expect(progressSchema).toBeDefined();
      expect(typeof progressSchema.safeParse).toBe('function');
    });

    test('returns undefined for unknown channels', () => {
      expect(getEventSchema('unknown-channel')).toBeUndefined();
    });
  });

  describe('validateEventPayload', () => {
    test('returns valid=true for channels without schema', () => {
      const result = validateEventPayload('unknown-channel', { any: 'data' });
      expect(result.valid).toBe(true);
      expect(result.data).toEqual({ any: 'data' });
    });

    test('returns valid=true for valid payloads', () => {
      const result = validateEventPayload('operation-progress', {
        type: 'batch_organize',
        current: 5,
        total: 10
      });
      expect(result.valid).toBe(true);
      expect(result.data.current).toBe(5);
    });

    test('returns valid=false for invalid payloads', () => {
      const result = validateEventPayload('file-operation-complete', {
        operation: 'invalid_operation', // Invalid enum value
        files: ['test.txt']
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('accepts undo-redo state changes with ISO action timestamps', () => {
      const result = validateEventPayload(IPC_CHANNELS.UNDO_REDO.STATE_CHANGED, {
        action: 'undo',
        result: {
          success: true,
          action: {
            id: 'action-1',
            type: 'FILE_MOVE',
            description: 'Move file back',
            timestamp: '2026-03-12T13:26:51.839Z'
          }
        }
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('operationProgressSchema', () => {
    test('validates batch_organize progress', () => {
      const result = validateEventPayload('operation-progress', {
        type: 'batch_organize',
        current: 5,
        total: 10,
        file: '/path/to/file.txt',
        success: true
      });
      expect(result.valid).toBe(true);
    });

    test('validates hint type', () => {
      const result = validateEventPayload('operation-progress', {
        type: 'hint',
        message: 'Use Select Directory to analyze a folder'
      });
      expect(result.valid).toBe(true);
    });

    test('allows optional fields to be missing', () => {
      const result = validateEventPayload('operation-progress', {
        current: 1,
        total: 5
      });
      expect(result.valid).toBe(true);
    });

    test('preserves rich model-download progress payloads', () => {
      const payload = {
        type: 'model-download',
        model: 'qwen.gguf',
        stage: 'model-download',
        dependency: 'models',
        progress: {
          model: 'qwen.gguf',
          filename: 'qwen.gguf',
          percent: 42,
          downloadedBytes: 420,
          totalBytes: 1000,
          speedBps: 100,
          etaSeconds: 6,
          companion: { name: 'mmproj.gguf' }
        }
      };
      const result = validateEventPayload('operation-progress', payload);
      expect(result.valid).toBe(true);
      expect(result.data).toEqual(payload);
    });
  });

  describe('analysisFileCompleteSchema (streaming per-file results)', () => {
    const CH = 'analysis:file-complete';

    test('accepts a successful file payload', () => {
      const result = validateEventPayload(CH, {
        batchId: 'b1',
        item: { filePath: '/a/b.pdf', success: true, result: { category: 'X' }, type: 'document' }
      });
      expect(result.valid).toBe(true);
    });

    test('accepts null type/error so a benign payload is never silently dropped', () => {
      const result = validateEventPayload(CH, {
        batchId: 'b1',
        item: { filePath: '/a/b.pdf', success: true, result: null, error: null, type: null }
      });
      expect(result.valid).toBe(true);
    });

    test('accepts a failed file payload with a string error', () => {
      const result = validateEventPayload(CH, {
        item: { filePath: '/a/b.pdf', success: false, error: 'analysis failed' }
      });
      expect(result.valid).toBe(true);
    });

    test('rejects a payload missing filePath', () => {
      const result = validateEventPayload(CH, { item: { success: true } });
      expect(result.valid).toBe(false);
    });
  });

  describe('fileOperationCompleteSchema', () => {
    test('validates move operation with single file', () => {
      const result = validateEventPayload('file-operation-complete', {
        operation: 'move',
        oldPath: '/old/path.txt',
        newPath: '/new/path.txt'
      });
      expect(result.valid).toBe(true);
    });

    test('validates move operation with batch files', () => {
      const result = validateEventPayload('file-operation-complete', {
        operation: 'move',
        files: ['/file1.txt', '/file2.txt'],
        destinations: ['/dest1.txt', '/dest2.txt']
      });
      expect(result.valid).toBe(true);
    });

    test('validates delete operation', () => {
      const result = validateEventPayload('file-operation-complete', {
        operation: 'delete',
        files: ['/deleted/file.txt']
      });
      expect(result.valid).toBe(true);
    });

    test('rejects invalid operation type', () => {
      const result = validateEventPayload('file-operation-complete', {
        operation: 'invalid',
        files: ['test.txt']
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('systemMetricsSchema', () => {
    test('validates full metrics', () => {
      const result = validateEventPayload('system-metrics', {
        uptime: 3600,
        memory: {
          used: 1024,
          total: 4096,
          percentage: 25
        },
        cpu: 15,
        timestamp: Date.now()
      });
      expect(result.valid).toBe(true);
    });

    test('validates minimal metrics', () => {
      const result = validateEventPayload('system-metrics', {
        timestamp: Date.now()
      });
      expect(result.valid).toBe(true);
    });

    test('preserves rich analytics metrics payloads', () => {
      const payload = {
        uptime: 3600,
        processedFiles: 12,
        successfulOperations: 10,
        failedOperations: 2,
        avgProcessingTime: 321,
        errorRate: 16.7,
        recentErrors: [{ timestamp: Date.now(), message: 'Boom', stack: 'stack' }],
        llamaHealth: { status: 'healthy', gpuBackend: 'cuda' },
        pipeline: { embedding: { degraded: true, recent: { total: 20 } } },
        stability: { search: { fallbackRate: 0.5 } }
      };
      const result = validateEventPayload('system-metrics', payload);
      expect(result.valid).toBe(true);
      expect(result.data).toEqual(payload);
    });
  });

  describe('notificationSchema', () => {
    test('validates notification with message', () => {
      const result = validateEventPayload('notification', {
        message: 'Operation complete',
        severity: 'success',
        duration: 3000
      });
      expect(result.valid).toBe(true);
    });

    test('validates notification with title', () => {
      const result = validateEventPayload('notification', {
        title: 'Success',
        variant: 'info'
      });
      expect(result.valid).toBe(true);
    });

    test('rejects invalid severity', () => {
      const result = validateEventPayload('notification', {
        message: 'Test',
        severity: 'invalid_severity'
      });
      expect(result.valid).toBe(false);
    });

    test('preserves extended notification metadata fields', () => {
      const payload = {
        message: 'Background task complete',
        severity: 'info',
        timestamp: '2026-03-05T10:00:00.000Z',
        source: 'main',
        data: { batchId: 'batch-123' },
        status: 'pending',
        groupKey: 'auto-analysis'
      };
      const result = validateEventPayload('notification', payload);
      expect(result.valid).toBe(true);
      expect(result.data).toEqual(expect.objectContaining(payload));
    });
  });

  describe('appErrorSchema', () => {
    test('validates error with message', () => {
      const result = validateEventPayload('app:error', {
        message: 'An error occurred',
        type: 'error',
        severity: 'critical'
      });
      expect(result.valid).toBe(true);
    });

    test('validates error with userMessage', () => {
      const result = validateEventPayload('app:error', {
        error: 'ECONNREFUSED',
        userMessage: 'Could not connect to server',
        code: 'NETWORK_ERROR'
      });
      expect(result.valid).toBe(true);
    });

    test('allows empty payload', () => {
      const result = validateEventPayload('app:error', {});
      expect(result.valid).toBe(true);
    });

    test('accepts app errors with timestamps from ErrorHandler', () => {
      const result = validateEventPayload('app:error', {
        message: 'An error occurred',
        type: 'error',
        timestamp: '2026-03-12T13:26:51.839Z'
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('settingsChangedExternalSchema', () => {
    test('validates settings change event', () => {
      const result = validateEventPayload('settings-changed-external', {
        settings: { theme: 'dark', autoSave: true },
        source: 'import',
        timestamp: Date.now()
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('vectorDbStatusChangedSchema', () => {
    test('validates connected status', () => {
      const result = validateEventPayload(IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED, {
        status: 'connected',
        timestamp: Date.now()
      });
      expect(result.valid).toBe(true);
    });

    test('validates error status with message', () => {
      const result = validateEventPayload(IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED, {
        status: 'error',
        error: 'Connection refused'
      });
      expect(result.valid).toBe(true);
    });

    test('rejects invalid status', () => {
      const result = validateEventPayload(IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED, {
        status: 'invalid_status'
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('smartFoldersUpdatedSchema', () => {
    test('validates the llm-enhancement signal payload', () => {
      const result = validateEventPayload('smart-folders-updated', {
        folderId: 'folder-123',
        reason: 'llm-enhancement',
        timestamp: Date.now()
      });
      expect(result.valid).toBe(true);
    });

    test('accepts an empty signal (all fields optional)', () => {
      const result = validateEventPayload('smart-folders-updated', {});
      expect(result.valid).toBe(true);
    });

    test('rejects wrong-typed fields', () => {
      const result = validateEventPayload('smart-folders-updated', {
        folderId: 123,
        timestamp: 'yesterday'
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('menuActionSchema', () => {
    test('validates valid menu actions', () => {
      const validActions = ['select-files', 'select-folder', 'open-settings', 'show-about'];

      for (const action of validActions) {
        const result = validateEventPayload('menu-action', action);
        expect(result.valid).toBe(true);
      }
    });

    test('rejects invalid menu action', () => {
      const result = validateEventPayload('menu-action', 'invalid-action');
      expect(result.valid).toBe(false);
    });
  });

  describe('appUpdateSchema', () => {
    test('validates update status', () => {
      const result = validateEventPayload('app:update', {
        status: 'downloading',
        progress: 45,
        version: '1.2.3'
      });
      expect(result.valid).toBe(true);
    });

    test('validates error status', () => {
      const result = validateEventPayload('app:update', {
        status: 'error',
        error: 'Network timeout'
      });
      expect(result.valid).toBe(true);
    });

    test('rejects invalid status', () => {
      const result = validateEventPayload('app:update', {
        status: 'invalid'
      });
      expect(result.valid).toBe(false);
    });
  });
});
