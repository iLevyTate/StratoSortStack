/**
 * A new name typed on an Organize card without the file's extension gets it
 * back on Preview and Move, even when the name has a dot of its own ("J.
 * Smith", "v1.2"). A name that ends with the file's extension, or with
 * another real file type typed on purpose, is sent as it is.
 */

import { renderHook } from '@testing-library/react';

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
  createOrganizeBatchAction: jest.fn(),
  previewBatchOrganize: jest.fn()
}));

const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
const { useOrganization } = require('../src/renderer/phases/organize/useOrganization');

const FINANCE = { id: 'fin', name: 'Finance', path: '/Users/user/Sorted/Finance' };

const hookOptions = (unprocessedFiles, editingFiles = {}) => ({
  unprocessedFiles,
  editingFiles,
  getFileWithEdits: (f) => f,
  findSmartFolderForCategory: (label) =>
    String(label).toLowerCase() === FINANCE.name.toLowerCase() ? FINANCE : null,
  defaultLocation: '/Users/user/Documents',
  smartFolders: [FINANCE],
  analysisResults: [],
  markFilesAsProcessed: jest.fn(),
  unmarkFilesAsProcessed: jest.fn(),
  actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
  phaseData: { organizedFiles: [] },
  addNotification: jest.fn(),
  dispatch: jest.fn(),
  executeAction: jest.fn(),
  addOrganizedFiles: jest.fn(),
  removeOrganizedFiles: jest.fn(),
  setOrganizingState: jest.fn()
});

/** The destination Preview sends for one file renamed to `typedName`. */
async function destinationFor(fileName, typedName) {
  const path = `/Users/user/Downloads/${fileName}`;
  const file = { path, name: fileName, analysis: { category: 'Finance', suggestedName: fileName } };
  const { result } = renderHook(() =>
    useOrganization(hookOptions([file], { [path]: { suggestedName: typedName } }))
  );
  await result.current.handlePreviewOrganize();
  return previewBatchOrganize.mock.lastCall[0][0].destination;
}

describe('useOrganization: a typed name keeps the file type', () => {
  beforeEach(() => {
    previewBatchOrganize.mockReset();
    previewBatchOrganize.mockImplementation(async (ops) => ({
      success: true,
      dryRun: true,
      total: ops.length,
      wouldMove: ops.map((op) => ({ source: op.source, destination: op.destination })),
      skipped: [],
      wouldCreateFolders: [],
      conflicts: 0
    }));
    global.window = global.window || {};
    global.window.electronAPI = {
      events: { onOperationProgress: jest.fn(() => jest.fn()) },
      files: { normalizePath: jest.fn((p) => p) }
    };
  });

  test('a dot in a name typed without the extension does not drop it', async () => {
    await expect(destinationFor('scan.pdf', 'Receipt from J. Smith')).resolves.toBe(
      '/Users/user/Sorted/Finance/Receipt from J. Smith.pdf'
    );
  });

  test('a version number is not an extension', async () => {
    await expect(destinationFor('notes.docx', 'Notes v1.2')).resolves.toBe(
      '/Users/user/Sorted/Finance/Notes v1.2.docx'
    );
  });

  test('a name typed with the extension is not given it twice', async () => {
    await expect(destinationFor('scan.pdf', 'Receipt.PDF')).resolves.toBe(
      '/Users/user/Sorted/Finance/Receipt.PDF'
    );
    await expect(destinationFor('logs.tar.gz', 'server logs.tar.gz')).resolves.toBe(
      '/Users/user/Sorted/Finance/server logs.tar.gz'
    );
  });

  test('a compound extension is added back whole', async () => {
    await expect(destinationFor('logs.tar.gz', 'server logs')).resolves.toBe(
      '/Users/user/Sorted/Finance/server logs.tar.gz'
    );
  });

  test('another real file type typed on purpose is kept', async () => {
    await expect(destinationFor('photo.jpeg', 'Beach.jpg')).resolves.toBe(
      '/Users/user/Sorted/Finance/Beach.jpg'
    );
  });
});
