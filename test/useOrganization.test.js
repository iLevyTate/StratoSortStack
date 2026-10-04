/**
 * Tests for useOrganization Hook
 * Tests main organization logic for batch file operations
 */

import { renderHook, act } from '@testing-library/react';

// Mock dependencies
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

jest.mock('../src/shared/constants', () => ({
  PHASES: { DISCOVER: 'discover', ORGANIZE: 'organize', COMPLETE: 'complete' },
  IPC_CHANNELS: {
    FILES: { PERFORM_OPERATION: 'files:perform-operation' }
  }
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  createOrganizeBatchAction: jest.fn((label, operations, callbacks, options) => ({
    type: 'organize-batch',
    label,
    operations,
    callbacks,
    options
  }))
}));

// Mock window.electronAPI
const mockElectronAPI = {
  organize: {
    auto: jest.fn()
  },
  events: {
    onOperationProgress: jest.fn()
  },
  files: {
    normalizePath: jest.fn((path) => path) // Just return path as-is for testing join logic
  }
};

describe('useOrganization', () => {
  let useOrganization;
  let useProgressTracking;

  beforeEach(() => {
    // jest.resetModules(); // Removed - breaks React hooks context
    jest.clearAllMocks();

    // Set up window.electronAPI fresh each test (test-setup.js may overwrite global.window)
    global.window = global.window || {};
    global.window.electronAPI = mockElectronAPI;

    mockElectronAPI.events.onOperationProgress.mockReturnValue(jest.fn());
    mockElectronAPI.organize.auto.mockResolvedValue({
      success: true,
      operations: [{ type: 'move', source: '/test.txt', destination: '/Documents/test.txt' }]
    });

    const module = require('../src/renderer/phases/organize/useOrganization');
    useOrganization = module.useOrganization;
    useProgressTracking = module.useProgressTracking;
  });

  describe('useProgressTracking', () => {
    test('initializes with empty progress', () => {
      const { result } = renderHook(() => useProgressTracking());

      expect(result.current.batchProgress).toEqual({
        current: 0,
        total: 0,
        currentFile: ''
      });
    });

    test('initializes with empty preview', () => {
      const { result } = renderHook(() => useProgressTracking());

      expect(result.current.organizePreview).toEqual([]);
    });

    test('initializes with isOrganizing false', () => {
      const { result } = renderHook(() => useProgressTracking());

      expect(result.current.isOrganizing).toBe(false);
    });

    test('setBatchProgress updates state', () => {
      const { result } = renderHook(() => useProgressTracking());

      act(() => {
        result.current.setBatchProgress({
          current: 5,
          total: 10,
          currentFile: 'test.txt'
        });
      });

      expect(result.current.batchProgress).toEqual({
        current: 5,
        total: 10,
        currentFile: 'test.txt'
      });
    });

    test('setOrganizePreview updates state', () => {
      const { result } = renderHook(() => useProgressTracking());

      act(() => {
        result.current.setOrganizePreview([
          { fileName: 'test.txt', destination: '/Documents/test.txt' }
        ]);
      });

      expect(result.current.organizePreview).toEqual([
        { fileName: 'test.txt', destination: '/Documents/test.txt' }
      ]);
    });

    test('setIsOrganizing updates state', () => {
      const { result } = renderHook(() => useProgressTracking());

      act(() => {
        result.current.setIsOrganizing(true);
      });

      expect(result.current.isOrganizing).toBe(true);
    });

    test('sets up progress listener on mount', () => {
      renderHook(() => useProgressTracking());

      expect(mockElectronAPI.events.onOperationProgress).toHaveBeenCalled();
    });

    test('handles missing progress event API gracefully', () => {
      const originalAPI = window.electronAPI.events;
      window.electronAPI.events = {};

      const { result } = renderHook(() => useProgressTracking());

      expect(result.current.batchProgress).toEqual({
        current: 0,
        total: 0,
        currentFile: ''
      });

      window.electronAPI.events = originalAPI;
    });
  });

  describe('useOrganization', () => {
    const createMockOptions = (overrides = {}) => ({
      unprocessedFiles: [
        {
          path: '/test.txt',
          name: 'test.txt',
          analysis: { category: 'documents', suggestedName: 'Test Document.txt' }
        }
      ],
      editingFiles: {},
      getFileWithEdits: jest.fn((file) => file),
      findSmartFolderForCategory: jest.fn(() => null),
      defaultLocation: '/Documents',
      smartFolders: [],
      analysisResults: [],
      markFilesAsProcessed: jest.fn(),
      unmarkFilesAsProcessed: jest.fn(),
      actions: {
        setPhaseData: jest.fn(),
        advancePhase: jest.fn()
      },
      phaseData: {
        organizedFiles: []
      },
      addNotification: jest.fn(),
      executeAction: jest.fn().mockResolvedValue({
        results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }]
      }),
      setOrganizedFiles: jest.fn(),
      addOrganizedFiles: jest.fn(),
      removeOrganizedFiles: jest.fn(),
      setOrganizingState: jest.fn(),
      ...overrides
    });

    test('returns handleOrganizeFiles function', () => {
      const { result } = renderHook(() => useOrganization(createMockOptions()));

      expect(typeof result.current.handleOrganizeFiles).toBe('function');
    });

    test('returns isOrganizing state', () => {
      const { result } = renderHook(() => useOrganization(createMockOptions()));

      expect(result.current.isOrganizing).toBe(false);
    });

    test('returns batchProgress state', () => {
      const { result } = renderHook(() => useOrganization(createMockOptions()));

      expect(result.current.batchProgress).toEqual({
        current: 0,
        total: 0,
        currentFile: ''
      });
    });

    test('returns organizePreview state', () => {
      const { result } = renderHook(() => useOrganization(createMockOptions()));

      expect(result.current.organizePreview).toEqual([]);
    });

    test('returns lastOrganizeSummary null until a successful organize batch', () => {
      const { result } = renderHook(() => useOrganization(createMockOptions()));

      expect(result.current.lastOrganizeSummary).toBeNull();
    });

    describe('handleOrganizeFiles', () => {
      test('does nothing with no files to process', async () => {
        const options = createMockOptions({ unprocessedFiles: [] });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.executeAction).not.toHaveBeenCalled();
      });

      // FI-02: every Approve/Move failure class must produce user-visible
      // feedback — "no visible result" was the original transcript complaint.
      describe('failure feedback (FI-02)', () => {
        test('empty selection early-return notifies instead of silently returning', async () => {
          const options = createMockOptions({ unprocessedFiles: [] });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(options.addNotification).toHaveBeenCalledWith(
            expect.stringMatching(/No files ready to organize/),
            'warning'
          );
        });

        test('IPC/execution failure surfaces an error notification', async () => {
          const options = createMockOptions({
            executeAction: jest.fn().mockRejectedValue(new Error('IPC channel closed'))
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(options.addNotification).toHaveBeenCalledWith(
            expect.stringMatching(/Organization failed/),
            'error'
          );
        });

        test('partial failure (e.g. destination conflict) surfaces a warning with counts', async () => {
          const options = createMockOptions({
            unprocessedFiles: [
              {
                path: '/a.txt',
                name: 'a.txt',
                analysis: { category: 'documents', suggestedName: 'A.txt' }
              },
              {
                path: '/b.txt',
                name: 'b.txt',
                analysis: { category: 'documents', suggestedName: 'B.txt' }
              }
            ],
            // Like the real UndoRedoSystem executor, invoke the action's
            // onExecute callback — the partial-failure warning lives there.
            executeAction: jest.fn().mockImplementation(async (action) => {
              const result = {
                results: [
                  { success: true, source: '/a.txt', destination: '/Documents/A.txt' },
                  { success: false, source: '/b.txt', error: 'EEXIST: destination exists' }
                ]
              };
              action?.callbacks?.onExecute?.(result);
              return result;
            })
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(options.addNotification).toHaveBeenCalledWith(
            expect.stringMatching(/1 failures/),
            'warning',
            expect.anything()
          );
        });

        test('zero successful operations surfaces a warning instead of silence', async () => {
          const options = createMockOptions({
            executeAction: jest.fn().mockResolvedValue({
              results: [{ success: false, source: '/test.txt', error: 'EACCES' }]
            })
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          const warned = options.addNotification.mock.calls.some(
            ([message, level]) =>
              /No files were organized successfully/.test(message) && level === 'warning'
          );
          expect(warned).toBe(true);
        });
      });

      test('does not use auto-organize in OrganizePhase (uses UI category/name for deterministic moves)', async () => {
        // Even if auto-organize is available and would return a different destination,
        // OrganizePhase must honor the reviewed UI category/name.
        mockElectronAPI.organize.auto.mockResolvedValue({
          success: true,
          operations: [
            { type: 'move', source: '/test.txt', destination: '/Documents/3D Print/test.txt' }
          ]
        });

        const options = createMockOptions({
          unprocessedFiles: [
            {
              path: '/test.txt',
              name: 'test.txt',
              analysis: { category: 'How To', suggestedName: 'Test Document.txt' }
            }
          ],
          findSmartFolderForCategory: jest.fn((category) =>
            category === 'How To' ? { name: 'How To', path: '/Documents/How To' } : null
          )
        });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(mockElectronAPI.organize.auto).not.toHaveBeenCalled();
        expect(options.executeAction).toHaveBeenCalled();
      });

      // D1: the engine's ranking decides the folder unless the user chose,
      // and each op carries the engine's pick so main can record an override.
      describe('suggestion engine ranking (D1)', () => {
        const FINANCE = { id: 'fin', name: 'Finance', path: '/Library/Finance' };
        const TAXES = { id: 'tax', name: 'Taxes', path: '/Library/Taxes' };
        const engineFinance = {
          folder: 'Finance',
          path: '/Library/Finance',
          folderId: 'fin',
          confidence: 0.81,
          source: 'semantic',
          explanation: 'This file\'s meaning matches "Finance"',
          alternatives: []
        };
        const byName = (category) => [FINANCE, TAXES].find((f) => f.name === category) || null;

        async function committedOps(overrides) {
          const {
            createOrganizeBatchAction
          } = require('../src/renderer/components/UndoRedoSystem');
          createOrganizeBatchAction.mockClear();
          const options = createMockOptions({
            unprocessedFiles: [
              {
                path: '/in/receipt.pdf',
                name: 'receipt.pdf',
                analysis: { category: 'Taxes', suggestedName: 'receipt.pdf' }
              }
            ],
            smartFolders: [FINANCE, TAXES],
            suggestionsByPath: new Map([['/in/receipt.pdf', engineFinance]]),
            findSmartFolderForCategory: jest.fn(byName),
            executeAction: jest.fn().mockResolvedValue({
              results: [{ success: true, source: '/in/receipt.pdf', destination: '/x' }]
            }),
            ...overrides
          });
          const { result } = renderHook(() => useOrganization(options));
          await act(async () => {
            await result.current.handleOrganizeFiles();
          });
          return createOrganizeBatchAction.mock.calls[0][1];
        }

        test('moves to the engine folder over the label, and says so on the op', async () => {
          const ops = await committedOps();
          expect(ops).toEqual([
            {
              type: 'move',
              source: '/in/receipt.pdf',
              destination: '/Library/Finance/receipt.pdf',
              suggestion: { folder: 'Finance', path: '/Library/Finance', source: 'engine' }
            }
          ]);
        });

        test('a user choice wins, and the op still names the engine pick it overrode', async () => {
          const ops = await committedOps({
            editingFiles: { '/in/receipt.pdf': { category: 'Taxes' } }
          });
          expect(ops[0].destination).toBe('/Library/Taxes/receipt.pdf');
          expect(ops[0].suggestion).toEqual({
            folder: 'Finance',
            path: '/Library/Finance',
            source: 'engine'
          });
        });

        test('without a ranking, name matching routes and the op carries no suggestion', async () => {
          const ops = await committedOps({ suggestionsByPath: new Map() });
          expect(ops[0].destination).toBe('/Library/Taxes/receipt.pdf');
          expect(ops[0]).not.toHaveProperty('suggestion');
        });
      });

      test('does not depend on auto-organize failure handling in OrganizePhase', async () => {
        mockElectronAPI.organize.auto.mockResolvedValue({
          success: false,
          error: 'Service unavailable'
        });

        const options = createMockOptions({
          unprocessedFiles: [
            {
              path: '/test.txt',
              name: 'test.txt',
              analysis: { category: 'Documents', suggestedName: 'Test Document.txt' }
            }
          ],
          findSmartFolderForCategory: jest.fn((category) =>
            category === 'Documents' ? { name: 'Documents', path: '/Documents/Documents' } : null
          )
        });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        // No auto-organize call; executeAction is used instead
        expect(mockElectronAPI.organize.auto).not.toHaveBeenCalled();
        expect(options.executeAction).toHaveBeenCalled();
      });

      // NOTE: The following notifications were produced by the auto-organize pipeline:
      // - needsReview
      // - failed files
      // - no operations generated
      // OrganizePhase now builds deterministic operations locally from the UI category/name,
      // so these auto-organize-only notifications are intentionally not emitted here.

      test('executes action with organize batch', async () => {
        const options = createMockOptions();
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.executeAction).toHaveBeenCalled();
      });

      // UX-4 pause/resume: pause signals the in-flight batch with a distinct
      // abort reason; a {paused:true} result parks the batch (no phase
      // advance, preview retained) and resumeOrganize re-invokes with the
      // journal batch id so done ops are skipped main-side.
      describe('pause and resume (UX-4)', () => {
        afterEach(() => {
          delete window.electronAPI.system;
        });

        test('pauseOrganize signals abortInvoke with the pause reason and sets isPausing', async () => {
          window.electronAPI.system = { abortInvoke: jest.fn() };
          const options = createMockOptions();
          const { result } = renderHook(() => useOrganization(options));

          act(() => {
            result.current.pauseOrganize();
          });

          expect(window.electronAPI.system.abortInvoke).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'user-pause-organize' })
          );
          expect(result.current.isPausing).toBe(true);
        });

        test('a paused result parks the batch: isPaused, no phase advance, info notification', async () => {
          const options = createMockOptions({
            executeAction: jest.fn().mockResolvedValue({
              success: true,
              paused: true,
              batchId: 'batch_1234567890_abcdef12',
              results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }],
              successCount: 1,
              cancelledCount: 2
            })
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(result.current.isPaused).toBe(true);
          expect(options.actions.advancePhase).not.toHaveBeenCalled();
          expect(options.addNotification).toHaveBeenCalledWith(
            expect.stringMatching(/paused/i),
            'info',
            expect.anything(),
            expect.anything()
          );
        });

        test('resumeOrganize re-invokes with the paused batch id and its operations', async () => {
          const executeAction = jest
            .fn()
            .mockResolvedValueOnce({
              success: true,
              paused: true,
              batchId: 'batch_1234567890_abcdef12',
              results: [],
              successCount: 1,
              cancelledCount: 1
            })
            .mockResolvedValueOnce({
              success: true,
              results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }],
              successCount: 2
            });
          const options = createMockOptions({ executeAction });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });
          expect(result.current.isPaused).toBe(true);

          const {
            createOrganizeBatchAction
          } = require('../src/renderer/components/UndoRedoSystem');
          createOrganizeBatchAction.mockClear();

          await act(async () => {
            await result.current.resumeOrganize();
          });

          expect(createOrganizeBatchAction).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Array),
            expect.any(Object),
            expect.objectContaining({ resumeBatchId: 'batch_1234567890_abcdef12' })
          );
          expect(result.current.isPaused).toBe(false);
        });

        test('a cancelled result surfaces precise counts from the handler', async () => {
          const options = createMockOptions({
            executeAction: jest.fn().mockResolvedValue({
              success: true,
              cancelled: true,
              cancelledCount: 2,
              results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }],
              successCount: 1,
              completedOperations: 1
            })
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(options.actions.advancePhase).not.toHaveBeenCalled();
          expect(options.addNotification).toHaveBeenCalledWith(
            expect.stringMatching(/cancelled/i),
            'warning'
          );
        });
      });

      // O-3: a batch organize is a multi-invoke user action — it must run
      // inside a preload trace session so every main-process log line it
      // produces groups under one correlation id.
      describe('correlation trace session (O-3)', () => {
        afterEach(() => {
          delete window.electronAPI.trace;
        });

        test('wraps a successful organize in a trace session (begin before, end after)', async () => {
          const end = jest.fn();
          window.electronAPI.trace = {
            beginSession: jest.fn(() => ({ traceId: 'tr-test', end }))
          };
          const options = createMockOptions();
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(window.electronAPI.trace.beginSession).toHaveBeenCalledTimes(1);
          expect(end).toHaveBeenCalledTimes(1);
          expect(options.executeAction).toHaveBeenCalled();
        });

        test('ends the trace session even when organize rejects', async () => {
          const end = jest.fn();
          window.electronAPI.trace = {
            beginSession: jest.fn(() => ({ traceId: 'tr-test', end }))
          };
          const options = createMockOptions({
            executeAction: jest.fn().mockRejectedValue(new Error('boom'))
          });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(end).toHaveBeenCalledTimes(1);
        });

        test('does not open a session for the empty-selection early return', async () => {
          const end = jest.fn();
          window.electronAPI.trace = {
            beginSession: jest.fn(() => ({ traceId: 'tr-test', end }))
          };
          const options = createMockOptions({ unprocessedFiles: [] });
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(window.electronAPI.trace.beginSession).not.toHaveBeenCalled();
        });

        test('tolerates a missing trace API', async () => {
          delete window.electronAPI.trace;
          const options = createMockOptions();
          const { result } = renderHook(() => useOrganization(options));

          await act(async () => {
            await result.current.handleOrganizeFiles();
          });

          expect(options.executeAction).toHaveBeenCalled();
          expect(options.actions.advancePhase).toHaveBeenCalledWith('complete');
        });
      });

      test('advances phase after successful organization', async () => {
        const options = createMockOptions();
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.actions.advancePhase).toHaveBeenCalledWith('complete');
      });

      test('handles organization errors', async () => {
        const options = createMockOptions({
          findSmartFolderForCategory: jest.fn((category) =>
            category === 'documents' ? { name: 'documents', path: '/Documents/documents' } : null
          ),
          executeAction: jest.fn().mockRejectedValue(new Error('Organization failed'))
        });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.addNotification).toHaveBeenCalledWith(
          'Organization failed: Organization failed',
          'error'
        );
      });

      test('resets state in finally block', async () => {
        const options = createMockOptions();
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.setOrganizingState).toHaveBeenCalledWith(false);
        expect(result.current.isOrganizing).toBe(false);
      });

      test('accepts specific files to organize', async () => {
        const options = createMockOptions();
        const filesToOrganize = [
          { path: '/specific.txt', name: 'specific.txt', analysis: { category: 'test' } }
        ];

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles(filesToOrganize);
        });

        expect(mockElectronAPI.organize.auto).not.toHaveBeenCalled();
        expect(options.executeAction).toHaveBeenCalled();
      });

      test('joins paths with backslashes on Windows-like root', async () => {
        const options = createMockOptions({
          defaultLocation: 'C:\\Users\\User\\Documents',
          findSmartFolderForCategory: jest.fn(() => ({ name: 'SmartFolder', path: null })),
          unprocessedFiles: [
            {
              path: 'test.txt',
              name: 'test.txt',
              analysis: { category: 'SmartFolder', suggestedName: 'test.txt' }
            }
          ]
        });
        const { result } = renderHook(() => useOrganization(options));
        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        const call = options.executeAction.mock.calls[0][0];
        const dest = call.operations[0].destination;
        // Verify destination has backslashes and correct structure
        expect(dest).toContain('C:\\Users\\User\\Documents\\SmartFolder\\test.txt');
      });

      test('preserves compound extensions when suggested name omits extension', async () => {
        const options = createMockOptions({
          findSmartFolderForCategory: jest.fn(() => ({ name: 'Documents', path: '/Documents' })),
          unprocessedFiles: [
            {
              path: '/archive.tar.gz',
              name: 'archive.tar.gz',
              analysis: { category: 'Documents', suggestedName: 'Project Archive' }
            }
          ]
        });

        const { result } = renderHook(() => useOrganization(options));
        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        const call = options.executeAction.mock.calls[0][0];
        const dest = call.operations[0].destination;
        expect(dest).toBe('/Documents/Project Archive.tar.gz');
      });

      test('routes via vendor when category does not match a smart folder', async () => {
        const options = createMockOptions({
          defaultLocation: '/Documents',
          unprocessedFiles: [
            {
              path: '/invoice.pdf',
              name: 'invoice.pdf',
              analysis: {
                category: 'Invoice',
                vendor: 'Acme Inc',
                suggestedName: 'invoice.pdf'
              }
            }
          ],
          findSmartFolderForCategory: jest.fn(() => null),
          findSmartFolderForFile: jest.fn((file) =>
            file.analysis?.vendor === 'Acme Inc'
              ? { name: 'Acme Inc', path: '/Documents/Acme Inc' }
              : null
          )
        });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        const call = options.executeAction.mock.calls[0][0];
        expect(call.operations[0].destination).toBe('/Documents/Acme Inc/invoice.pdf');
      });

      test('routes unmatched categories to Uncategorized deterministically', async () => {
        const options = createMockOptions({
          defaultLocation: '/Documents',
          unprocessedFiles: [
            {
              path: '/design.stl',
              name: 'design.stl',
              analysis: { category: '3D Print', suggestedName: 'design.stl' }
            }
          ],
          findSmartFolderForCategory: jest.fn((category) => {
            if (category === 'Uncategorized') {
              return { name: 'Uncategorized', path: '/Documents/Uncategorized' };
            }
            return null;
          })
        });
        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.executeAction).toHaveBeenCalled();
        const call = options.executeAction.mock.calls[0][0];
        expect(call.operations[0].destination).toBe('/Documents/Uncategorized/design.stl');
        expect(options.addNotification).toHaveBeenCalledWith(
          expect.stringContaining('changed from "3D Print" to "Uncategorized"'),
          'warning',
          5000,
          'category-changed'
        );
      });
    });

    describe('fallback operations builder', () => {
      test('uses fallback when auto-organize is not available', async () => {
        delete mockElectronAPI.organize.auto;

        const options = createMockOptions({
          findSmartFolderForCategory: jest.fn(() => ({
            name: 'Documents',
            path: '/Documents'
          }))
        });

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.executeAction).toHaveBeenCalled();

        // Restore
        mockElectronAPI.organize = { auto: jest.fn() };
      });
    });

    describe('state callbacks', () => {
      test('onExecute updates organized files', async () => {
        const options = createMockOptions();

        options.executeAction.mockImplementation(async (action) => {
          // Simulate calling the execute callback
          action.callbacks.onExecute({
            results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }]
          });
          return { results: [{ success: true }] };
        });

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.addOrganizedFiles).toHaveBeenCalled();
        expect(options.markFilesAsProcessed).toHaveBeenCalled();
      });

      test('onUndo restores files to unprocessed', async () => {
        const options = createMockOptions();

        options.executeAction.mockImplementation(async (action) => {
          // Simulate calling the undo callback
          action.callbacks.onUndo({
            results: [{ success: true, originalPath: '/test.txt' }],
            successCount: 1,
            failCount: 0
          });
          return { results: [{ success: true }] };
        });

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.removeOrganizedFiles).toHaveBeenCalled();
        expect(options.unmarkFilesAsProcessed).toHaveBeenCalled();
      });

      test('onRedo re-organizes files', async () => {
        const options = createMockOptions();

        options.executeAction.mockImplementation(async (action) => {
          // Simulate calling the redo callback
          action.callbacks.onRedo({
            results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }],
            successCount: 1,
            failCount: 0
          });
          return { results: [{ success: true }] };
        });

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        expect(options.markFilesAsProcessed).toHaveBeenCalled();
      });

      test('onRedo filters out already organized files', async () => {
        const options = createMockOptions({
          phaseData: {
            organizedFiles: [
              {
                originalPath: '/test.txt',
                path: '/Documents/test.txt'
              }
            ]
          },
          setOrganizedFiles: jest.fn()
        });

        options.executeAction.mockImplementation(async (action) => {
          // Simulate redo with SAME file already in state
          action.callbacks.onRedo({
            results: [{ success: true, source: '/test.txt', destination: '/Documents/test.txt' }],
            successCount: 1,
            failCount: 0
          });
          return { results: [{ success: true }] };
        });

        const { result } = renderHook(() => useOrganization(options));

        await act(async () => {
          await result.current.handleOrganizeFiles();
        });

        // setOrganizedFiles should NOT be called because the file is already there
        // or effectively filtered out.
        // Wait, if no unique results, setOrganizedFiles is skipped?
        // Code: if (uniqueResults.length > 0) { ... }
        expect(options.addOrganizedFiles).not.toHaveBeenCalled();
      });

      describe('only rows the main process reported as moved are synced (R2)', () => {
        const organizedFiles = ['a', 'b', 'c'].map((n) => ({
          originalPath: `/inbox/${n}.txt`,
          path: `/sorted/${n}.txt`
        }));
        const failure = { success: false, code: 'UNDO_SOURCE_MISSING', message: 'gone' };
        const partialUndo = {
          success: false,
          partial: true,
          results: [
            { success: true, source: '/sorted/a.txt', destination: '/inbox/a.txt' },
            {
              success: false,
              source: '/sorted/b.txt',
              destination: '/inbox/b.txt',
              error: 'ENOENT'
            }
          ],
          successCount: 1,
          failCount: 1
        };
        const notified = (options, pattern) =>
          options.addNotification.mock.calls.some(([message]) => pattern.test(message));

        const runWithCallback = async (name, payload, overrides = {}) => {
          const options = createMockOptions({
            dispatch: jest.fn(),
            phaseData: { organizedFiles },
            ...overrides
          });
          options.executeAction.mockImplementation(async (action) => {
            action.callbacks[name](payload);
            return { results: [{ success: true }] };
          });
          const { result } = renderHook(() => useOrganization(options));
          await act(async () => {
            await result.current.handleOrganizeFiles();
          });
          return options;
        };

        test('onUndo with a failed result leaves organized files and processed marks untouched', async () => {
          const options = await runWithCallback('onUndo', failure);

          expect(options.removeOrganizedFiles).not.toHaveBeenCalled();
          expect(options.unmarkFilesAsProcessed).not.toHaveBeenCalled();
          expect(options.dispatch).not.toHaveBeenCalled();
          expect(notified(options, /Undo complete/)).toBe(false);
        });

        test('onUndo with a partial result removes and remaps exactly the successful row', async () => {
          const options = await runWithCallback('onUndo', partialUndo);

          expect(options.removeOrganizedFiles).toHaveBeenCalledWith(['/inbox/a.txt']);
          const unmarked = options.unmarkFilesAsProcessed.mock.calls[0][0];
          expect(unmarked).toEqual(expect.arrayContaining(['/inbox/a.txt', '/sorted/a.txt']));
          expect(unmarked).not.toEqual(expect.arrayContaining(['/inbox/b.txt']));
          expect(options.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'files/updateFilePathsAfterMove',
              payload: { oldPaths: ['/sorted/a.txt'], newPaths: ['/inbox/a.txt'] }
            })
          );
          expect(options.addNotification).toHaveBeenCalledWith(
            'Undo partially complete: 1 files restored, 1 failed.',
            'warning'
          );
          expect(notified(options, /Undo complete/)).toBe(false);
        });

        test('onRedo with a failed result adds nothing and remaps nothing', async () => {
          const options = await runWithCallback('onRedo', failure, {
            phaseData: { organizedFiles: [] }
          });

          expect(options.addOrganizedFiles).not.toHaveBeenCalled();
          expect(options.markFilesAsProcessed).not.toHaveBeenCalled();
          expect(options.dispatch).not.toHaveBeenCalled();
          expect(notified(options, /Redo complete/)).toBe(false);
        });

        test('onRedo with a partial result re-organizes exactly the successful row', async () => {
          const options = await runWithCallback(
            'onRedo',
            {
              success: false,
              partial: true,
              results: [
                { success: true, source: '/inbox/a.txt', destination: '/sorted/a.txt' },
                {
                  success: false,
                  source: '/inbox/b.txt',
                  destination: '/sorted/b.txt',
                  error: 'EEXIST'
                }
              ],
              successCount: 1,
              failCount: 1
            },
            { phaseData: { organizedFiles: [] } }
          );

          expect(options.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'files/updateFilePathsAfterMove',
              payload: { oldPaths: ['/inbox/a.txt'], newPaths: ['/sorted/a.txt'] }
            })
          );
          expect(options.addOrganizedFiles).toHaveBeenCalledWith([
            expect.objectContaining({ originalPath: '/inbox/a.txt', path: '/sorted/a.txt' })
          ]);
          expect(options.markFilesAsProcessed).toHaveBeenCalledWith(
            expect.not.arrayContaining(['/inbox/b.txt'])
          );
          expect(options.addNotification).toHaveBeenCalledWith(
            'Redo partially complete: 1 files re-organized, 1 failed.',
            'warning'
          );
        });
      });

      test('state callbacks still update global state after unmount', async () => {
        jest.useFakeTimers();
        const options = createMockOptions();
        options.executeAction.mockImplementation(
          (action) =>
            new Promise((resolve) => {
              setTimeout(() => {
                action.callbacks.onExecute({
                  results: [
                    { success: true, source: '/test.txt', destination: '/Documents/test.txt' }
                  ]
                });
                resolve({ results: [{ success: true }] });
              }, 10);
            })
        );

        const { result, unmount } = renderHook(() => useOrganization(options));

        await act(async () => {
          const pending = result.current.handleOrganizeFiles();
          unmount();
          jest.advanceTimersByTime(20);
          await pending;
        });

        expect(options.addOrganizedFiles).toHaveBeenCalled();
        expect(options.markFilesAsProcessed).toHaveBeenCalled();
        jest.useRealTimers();
      });
    });
  });
});
