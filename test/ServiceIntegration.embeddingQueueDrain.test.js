/**
 * CP-10: persisted embedding queues are restored and flushed at startup.
 *
 * Before this fix EmbeddingQueue.initialize() only ran from the first
 * enqueue(), so a queue persisted before a crash sat idle until something new
 * was analyzed. ServiceIntegration now drains both stage queues once its own
 * initialization has resolved the vector service.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/main/services/SmartFolderWatcher', () => {
  return function MockSmartFolderWatcher() {};
});

jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: { initialize: jest.fn().mockResolvedValue(undefined) },
  organizeQueue: { initialize: jest.fn().mockResolvedValue(undefined) }
}));

const mockContainer = {
  resolve: jest.fn(),
  tryResolve: jest.fn(),
  has: jest.fn(),
  registerSingleton: jest.fn(),
  shutdown: jest.fn()
};

const mockServiceIds = {
  ANALYSIS_HISTORY: 'ANALYSIS_HISTORY',
  UNDO_REDO: 'UNDO_REDO',
  PROCESSING_STATE: 'PROCESSING_STATE',
  RELATIONSHIP_INDEX: 'RELATIONSHIP_INDEX',
  ORAMA_VECTOR: 'ORAMA_VECTOR',
  FOLDER_MATCHING: 'FOLDER_MATCHING',
  SETTINGS: 'SETTINGS',
  ORGANIZATION_SUGGESTION: 'ORGANIZATION_SUGGESTION',
  AUTO_ORGANIZE: 'AUTO_ORGANIZE',
  SMART_FOLDER_WATCHER: 'SMART_FOLDER_WATCHER',
  DOWNLOAD_WATCHER: 'DOWNLOAD_WATCHER',
  LEARNING_FEEDBACK: 'LEARNING_FEEDBACK'
};

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: mockContainer,
  ServiceIds: mockServiceIds,
  SHUTDOWN_ORDER: []
}));

const ServiceIntegration = require('../src/main/services/ServiceIntegration');
const stageQueues = require('../src/main/analysis/embeddingQueue/stageQueues');

function createIntegrationForTest({ vectorService } = {}) {
  const analysisHistory = {
    initialize: jest.fn().mockResolvedValue(),
    setOnEntriesRemovedCallback: jest.fn()
  };
  const services = {
    [mockServiceIds.ANALYSIS_HISTORY]: analysisHistory,
    [mockServiceIds.UNDO_REDO]: { initialize: jest.fn().mockResolvedValue() },
    [mockServiceIds.PROCESSING_STATE]: { initialize: jest.fn().mockResolvedValue() },
    [mockServiceIds.RELATIONSHIP_INDEX]: {},
    [mockServiceIds.ORAMA_VECTOR]:
      vectorService === undefined ? { initialize: jest.fn().mockResolvedValue() } : vectorService,
    [mockServiceIds.FOLDER_MATCHING]: { initialize: jest.fn().mockResolvedValue() },
    [mockServiceIds.SETTINGS]: { getAll: jest.fn(() => ({})) },
    [mockServiceIds.ORGANIZATION_SUGGESTION]: {},
    [mockServiceIds.AUTO_ORGANIZE]: {}
  };
  mockContainer.resolve.mockImplementation((id) => (id in services ? services[id] : null));
  const integration = new ServiceIntegration();
  integration._registerCoreServices = jest.fn();
  return integration;
}

describe('ServiceIntegration drains persisted embedding queues (CP-10)', () => {
  beforeEach(() => {
    mockContainer.resolve.mockReset();
    stageQueues.analysisQueue.initialize.mockClear();
    stageQueues.organizeQueue.initialize.mockClear();
  });

  test('calls initialize on both stage queues after service init', async () => {
    const integration = createIntegrationForTest();

    const result = await integration.initialize();

    expect(result.success).toBe(true);
    expect(stageQueues.analysisQueue.initialize).toHaveBeenCalledTimes(1);
    expect(stageQueues.organizeQueue.initialize).toHaveBeenCalledTimes(1);
  });

  test('drains only after the vector service has initialized', async () => {
    const order = [];
    const vectorService = {
      initialize: jest.fn(async () => {
        order.push('vector');
      })
    };
    stageQueues.analysisQueue.initialize.mockImplementation(async () => {
      order.push('analysisQueue');
    });
    stageQueues.organizeQueue.initialize.mockImplementation(async () => {
      order.push('organizeQueue');
    });
    const integration = createIntegrationForTest({ vectorService });

    await integration.initialize();

    expect(order[0]).toBe('vector');
    expect(order.slice(1).sort()).toEqual(['analysisQueue', 'organizeQueue']);
  });

  test('skips the drain when the vector service is unavailable', async () => {
    const integration = createIntegrationForTest({ vectorService: null });

    const result = await integration.initialize();

    expect(result.success).toBe(true);
    expect(stageQueues.analysisQueue.initialize).not.toHaveBeenCalled();
    expect(stageQueues.organizeQueue.initialize).not.toHaveBeenCalled();
  });

  test('a failing queue restore is logged and never fails initialization', async () => {
    stageQueues.analysisQueue.initialize.mockRejectedValueOnce(new Error('disk gone'));
    const integration = createIntegrationForTest();

    const result = await integration.initialize();

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(stageQueues.organizeQueue.initialize).toHaveBeenCalledTimes(1);
  });
});
