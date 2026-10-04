/**
 * A-1 oracle: for services exposing BOTH a module-level getInstance() and a
 * DI-container registration, the two paths must always yield the SAME
 * instance — in either order of first use. This pins the invariant that the
 * dual-path pattern can never fork into two live service instances.
 */

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  createSafeLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock-user-data') }
}));

describe('singleton/container consistency (A-1)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('ModelDownloadManager', () => {
    afterEach(async () => {
      const mdm = require('../../src/main/services/ModelDownloadManager');
      if (typeof mdm.resetInstance === 'function') {
        await mdm.resetInstance();
      }
    });

    test('register-then-getInstance yields the container instance', () => {
      const { container, ServiceIds } = require('../../src/main/services/ServiceContainer');
      const {
        getInstance,
        registerWithContainer
      } = require('../../src/main/services/ModelDownloadManager');

      registerWithContainer(container, ServiceIds.MODEL_DOWNLOAD_MANAGER);
      const resolved = container.resolve(ServiceIds.MODEL_DOWNLOAD_MANAGER);

      expect(getInstance()).toBe(resolved);
    });

    test('getInstance-then-register migrates the local instance into the container', () => {
      const { container, ServiceIds } = require('../../src/main/services/ServiceContainer');
      const {
        getInstance,
        registerWithContainer
      } = require('../../src/main/services/ModelDownloadManager');

      const local = getInstance();
      registerWithContainer(container, ServiceIds.MODEL_DOWNLOAD_MANAGER);
      const resolved = container.resolve(ServiceIds.MODEL_DOWNLOAD_MANAGER);

      expect(resolved).toBe(local);
      expect(getInstance()).toBe(resolved);
    });
  });

  describe('ParallelEmbeddingService', () => {
    afterEach(async () => {
      const pes = require('../../src/main/services/ParallelEmbeddingService');
      await pes.resetInstance();
    });

    test('register-then-getInstance yields the container instance', () => {
      const { container, ServiceIds } = require('../../src/main/services/ServiceContainer');
      const {
        getInstance,
        registerWithContainer
      } = require('../../src/main/services/ParallelEmbeddingService');

      registerWithContainer(container, ServiceIds.PARALLEL_EMBEDDING);
      const resolved = container.resolve(ServiceIds.PARALLEL_EMBEDDING);

      expect(getInstance()).toBe(resolved);
    });

    test('getInstance-then-register migrates the local instance into the container', () => {
      const { container, ServiceIds } = require('../../src/main/services/ServiceContainer');
      const {
        getInstance,
        registerWithContainer
      } = require('../../src/main/services/ParallelEmbeddingService');

      const local = getInstance();
      registerWithContainer(container, ServiceIds.PARALLEL_EMBEDDING);
      const resolved = container.resolve(ServiceIds.PARALLEL_EMBEDDING);

      expect(resolved).toBe(local);
      expect(getInstance()).toBe(resolved);
    });
  });
});
