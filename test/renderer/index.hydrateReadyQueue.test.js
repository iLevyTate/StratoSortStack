/**
 * @jest-environment jsdom
 */
/**
 * The renderer entry restores the durable ready-to-organize queue at startup
 * and names those files with the default naming convention. That default is
 * the persisted settings (uiSlice.selectNamingDefaults); files.namingConvention
 * is only a renderer mirror and may be stale, so it must not win.
 */

let mockState = {};
const mockDispatch = jest.fn((action) => action);

jest.mock('../../src/renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => mockState,
    dispatch: (action) => mockDispatch(action)
  }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('react-dom/client', () => ({
  createRoot: jest.fn(() => ({ render: jest.fn() }))
}));

jest.mock('../../src/renderer/App.js', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../src/renderer/components/ErrorBoundary', () => ({
  GlobalErrorBoundary: ({ children }) => children
}));

jest.mock('../../src/renderer/store/slices/systemSlice', () => ({
  fetchDocumentsPath: jest.fn(() => ({ type: 'system/fetchDocumentsPath' })),
  fetchRedactPaths: jest.fn(() => ({ type: 'system/fetchRedactPaths' }))
}));

jest.mock('../../src/renderer/store/slices/filesSlice', () => ({
  addSelectedFiles: jest.fn((files) => ({ type: 'files/addSelectedFiles', payload: files })),
  fetchSmartFolders: jest.fn(() => ({ type: 'files/fetchSmartFolders' })),
  mergeFileStates: jest.fn((states) => ({ type: 'files/mergeFileStates', payload: states })),
  setOrganizedFiles: jest.fn((files) => ({ type: 'files/setOrganizedFiles', payload: files }))
}));

jest.mock('../../src/renderer/store/slices/analysisSlice', () => ({
  mergeAnalysisResults: jest.fn((results) => ({
    type: 'analysis/mergeAnalysisResults',
    payload: results
  }))
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  ...jest.requireActual('../../src/renderer/store/slices/uiSlice'),
  fetchSettings: jest.fn(() => ({ type: 'ui/fetchSettings' }))
}));

jest.mock('../../src/renderer/utils/analysisHistoryFetch', () => ({
  fetchAnalysisHistoryPages: jest.fn(async () => [])
}));

const mockMergeReadyQueueIntoState = jest.fn(() => ({
  hydratedCount: 0,
  addedSelectedFiles: [],
  addedAnalysisResults: [],
  addedFileStates: {}
}));

jest.mock('../../src/renderer/utils/readyQueueHydration', () => ({
  normalizeReadyQueuePayload: jest.fn((response) => response?.entries || []),
  mergeReadyQueueIntoState: (...args) => mockMergeReadyQueueIntoState(...args)
}));

jest.mock('../../src/shared/perfMarks', () => ({
  mark: jest.fn(),
  measure: jest.fn()
}));

jest.mock('../../src/renderer/utils/scrollLock', () => ({
  lockAppScroll: jest.fn()
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderer startup: durable ready-queue naming', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDispatch.mockClear();
    mockMergeReadyQueueIntoState.mockClear();
    window.localStorage.setItem('stratosort_history_repair_done', 'true');
    window.electronAPI = {
      analysis: {
        getReadyQueue: jest.fn(async () => ({
          entries: [{ path: '/docs/a.pdf', analysis: { category: 'Invoices' } }]
        }))
      }
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    window.localStorage.clear();
  });

  test('names hydrated files with the persisted settings, not the stale mirror', async () => {
    mockState = {
      ui: {
        settings: {
          namingConvention: 'subject-date',
          dateFormat: 'YYYY-MM-DD',
          caseConvention: 'kebab-case',
          separator: '-'
        }
      },
      files: {
        // Stale mirror from localStorage: an older choice the user changed.
        namingConvention: {
          convention: 'keep-original',
          dateFormat: 'MM-DD-YYYY',
          caseConvention: 'lowercase',
          separator: '_'
        },
        selectedFiles: [],
        fileStates: {},
        organizedFiles: []
      },
      analysis: { results: [] }
    };

    jest.isolateModules(() => {
      require('../../src/renderer/index.js');
    });
    await flush();
    await flush();

    expect(mockMergeReadyQueueIntoState).toHaveBeenCalledTimes(1);
    const namingSettings = mockMergeReadyQueueIntoState.mock.calls[0][2];
    expect(namingSettings).toMatchObject({
      convention: 'subject-date',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'kebab-case',
      separator: '-'
    });
  });

  test('before settings arrive, the mirror still fills the naming', async () => {
    mockState = {
      ui: { settings: null },
      files: {
        namingConvention: {
          convention: 'subject-date',
          dateFormat: 'MM-DD-YYYY',
          caseConvention: 'lowercase',
          separator: '_'
        },
        selectedFiles: [],
        fileStates: {},
        organizedFiles: []
      },
      analysis: { results: [] }
    };

    jest.isolateModules(() => {
      require('../../src/renderer/index.js');
    });
    await flush();
    await flush();

    expect(mockMergeReadyQueueIntoState).toHaveBeenCalledTimes(1);
    expect(mockMergeReadyQueueIntoState.mock.calls[0][2]).toMatchObject({
      convention: 'subject-date',
      dateFormat: 'MM-DD-YYYY',
      caseConvention: 'lowercase',
      separator: '_'
    });
  });
});
