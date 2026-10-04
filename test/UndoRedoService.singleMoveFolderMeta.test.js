/**
 * @jest-environment node
 *
 * UndoRedoService — a single FILE_MOVE undo/redo carries the destination's
 * Smart Folder context to the coordinator, as the BATCH_* loops do.
 *
 * The forward move stamps the Smart Folder onto the vector row and the
 * history entry. Undoing it moves the file back out; the coordinator only
 * clears those fields when told to, so the single-file paths must hand it
 * the same folderMeta the batch paths resolve.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/test/userData')
  }
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    access: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn().mockResolvedValue([]),
    rm: jest.fn().mockResolvedValue()
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(),
  durableWriteJson: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/pathSanitization', () => ({
  ...jest.requireActual('../src/shared/pathSanitization'),
  validateFileOperationPath: jest.fn(async (candidate) => ({
    valid: true,
    normalizedPath: String(candidate)
  }))
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn(() => null),
    has: jest.fn(() => false),
    resolve: jest.fn(() => null)
  },
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR',
    FILE_PATH_COORDINATOR: 'FILE_PATH_COORDINATOR'
  }
}));

jest.mock('../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn(async () => [
    { id: 'invoices', name: 'Invoices', path: '/smart/Invoices' }
  ])
}));

const UndoRedoService = require('../src/main/services/UndoRedoService');
const { container } = require('../src/main/services/ServiceContainer');

const SOURCE = '/downloads/a.pdf';
const IN_FOLDER = '/smart/Invoices/a.pdf';
const FOLDER_META = {
  newSmartFolder: 'Invoices',
  newSmartFolderPath: '/smart/Invoices',
  newCategory: 'Invoices'
};

describe('UndoRedoService - single FILE_MOVE undo/redo folder metadata', () => {
  let service;
  let coordinator;

  beforeEach(async () => {
    jest.clearAllMocks();
    coordinator = {
      atomicPathUpdate: jest.fn().mockResolvedValue({ success: true, errors: [], updated: {} })
    };
    container.has.mockReturnValue(true);
    container.resolve.mockReturnValue(coordinator);

    service = new UndoRedoService({ saveDebounceMs: 0 });
    service.initialized = true;
    jest.spyOn(service, 'safeMove').mockResolvedValue();
    jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();
  });

  afterEach(() => {
    container.has.mockReturnValue(false);
    container.resolve.mockReturnValue(null);
  });

  test('undoing a move out of a Smart Folder clears the folder fields on the row and history entry', async () => {
    await service.recordAction('FILE_MOVE', { originalPath: SOURCE, newPath: IN_FOLDER });

    await service.undo();

    expect(coordinator.atomicPathUpdate).toHaveBeenCalledTimes(1);
    expect(coordinator.atomicPathUpdate).toHaveBeenCalledWith(IN_FOLDER, SOURCE, {
      type: 'undo_redo',
      skipProcessingState: true,
      folderMeta: { clearSmartFolder: true }
    });
  });

  test('redoing that move stamps the Smart Folder again', async () => {
    await service.recordAction('FILE_MOVE', { originalPath: SOURCE, newPath: IN_FOLDER });
    await service.undo();
    coordinator.atomicPathUpdate.mockClear();

    await service.redo();

    expect(coordinator.atomicPathUpdate).toHaveBeenCalledTimes(1);
    expect(coordinator.atomicPathUpdate).toHaveBeenCalledWith(SOURCE, IN_FOLDER, {
      type: 'undo_redo',
      skipProcessingState: true,
      folderMeta: FOLDER_META
    });
  });

  test('undoing a move into a Smart Folder carries that folder back with the file', async () => {
    await service.recordAction('FILE_MOVE', { originalPath: IN_FOLDER, newPath: SOURCE });

    await service.undo();

    expect(coordinator.atomicPathUpdate).toHaveBeenCalledWith(SOURCE, IN_FOLDER, {
      type: 'undo_redo',
      skipProcessingState: true,
      folderMeta: FOLDER_META
    });
  });
});
