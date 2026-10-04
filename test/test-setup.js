/**
 * Test Setup for Stratosort Document Processing Tests
 * Initializes mocks, global variables, and test utilities
 */

// Import jest-dom for React Testing Library matchers (toBeInTheDocument, etc.)
require('@testing-library/jest-dom');

const { vol, fs: memfs } = require('memfs');
const path = require('path');
const { EventEmitter } = require('events');
const { clearTimeout: nodeClearTimeout, clearInterval: nodeClearInterval } = require('timers');

// Avoid noisy MaxListeners warnings in Jest runs
EventEmitter.defaultMaxListeners = 50;
process.setMaxListeners(50);

// Use platform-appropriate temp directory for memfs
// On Windows, use /tmp as a virtual Unix-style path that memfs understands
const MOCK_TMP_DIR = '/tmp';

// Apply wrappers to memfs before mocking
const originalWriteFile = memfs.promises.writeFile.bind(memfs.promises);
memfs.promises.writeFile = async (filePath, data, options) => {
  // Normalize path to Unix-style for memfs
  const normalizedPath = filePath.replace(/\\/g, '/');
  await memfs.promises.mkdir(path.dirname(normalizedPath).replace(/\\/g, '/'), {
    recursive: true
  });
  return originalWriteFile(normalizedPath, data, options);
};

const originalRename = memfs.promises.rename.bind(memfs.promises);
memfs.promises.rename = async (oldPath, newPath) => {
  // Normalize paths to Unix-style for memfs
  const normalizedOld = oldPath.replace(/\\/g, '/');
  const normalizedNew = newPath.replace(/\\/g, '/');
  await memfs.promises.mkdir(path.dirname(normalizedNew).replace(/\\/g, '/'), {
    recursive: true
  });
  return originalRename(normalizedOld, normalizedNew);
};

const originalMkdir = memfs.promises.mkdir.bind(memfs.promises);
memfs.promises.mkdir = async (dirPath, options) => {
  // Normalize path to Unix-style for memfs
  const normalizedPath = dirPath.replace(/\\/g, '/');
  return originalMkdir(normalizedPath, options);
};

const originalReadFile = memfs.promises.readFile.bind(memfs.promises);
memfs.promises.readFile = async (filePath, options) => {
  // Normalize path to Unix-style for memfs
  const normalizedPath = filePath.replace(/\\/g, '/');
  return originalReadFile(normalizedPath, options);
};

// Polyfill mkdtemp for memfs
if (!memfs.promises.mkdtemp) {
  memfs.promises.mkdtemp = async (prefix) => {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    const tempDir = normalizedPrefix + Date.now() + Math.random().toString(36).substring(2, 8);
    await memfs.promises.mkdir(tempDir, { recursive: true });
    return tempDir;
  };
}

// Mock the logger BEFORE mocking fs. Pino's sonic-boom transport calls fs.write()
// which fails with EBADF when fs is replaced by memfs (no real file descriptors).
// Tests that need custom logger behavior can override with their own jest.mock().
jest.mock('../src/shared/logger', () => require('./mocks/logger'));

// Enable IPC sender bypass for every test. The validator no longer inspects
// NODE_ENV (so a leaked env var cannot disable origin checks in a packaged
// build); tests must opt in explicitly. The validator reads bypass state from
// `globalThis.__stratosort_ipc_test_bypass__` (not module-scoped state) so it
// survives `jest.resetModules()`. We set the flag directly here rather than
// require()-ing the validator because some test files mock the logger without
// `createLogger`, which would break a transitive require chain.
beforeEach(() => {
  globalThis.__stratosort_ipc_test_bypass__ = true;
});

jest.mock('fs', () => require('memfs').fs);
jest.mock('fs/promises', () => require('memfs').fs.promises);
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  tmpdir: () => MOCK_TMP_DIR
}));

// Silence log/info/debug but preserve the selective console.warn/error
// filter installed by test-globals.js (which passes non-pdfjs output through).
// C-1 FIX: Only mock log/info/debug — do NOT overwrite warn/error from test-globals.
global.console.log = jest.fn();
global.console.info = jest.fn();
global.console.debug = jest.fn();

// C-2 FIX: Only set up DOM mocks when there's no real DOM (node environment).
// In jsdom environment, global.document is a real Document and must NOT be overwritten.
// test-globals.js already guards with `global.document = global.document || { ... }`.
const _hasRealDom =
  typeof global.document !== 'undefined' && typeof global.document.createTextNode === 'function';

if (!_hasRealDom) {
  // Node environment — provide minimal document mock (merges with test-globals.js)
  Object.assign(global.document || {}, {
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    createElement: jest.fn(() => ({
      click: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      style: {},
      setAttribute: jest.fn(),
      getAttribute: jest.fn()
    }))
  });
}

// Only set up window mock if it doesn't already exist (jsdom provides its own)
if (typeof global.window === 'undefined' || global.window === null) {
  global.window = {
    location: { href: 'http://localhost' },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn()
  };
}

// Initialize test state
global.documentStore = [];
global.processingQueue = [];
global.stateListeners = [];
global.progressListeners = [];
global.aiConfig = {
  confidenceThreshold: 0.7,
  folderNamingPattern: '{category}/{type}',
  enableDateExtraction: true,
  categories: ['Financial', 'Legal', 'Project', 'Personal', 'Technical']
};

// Clear the in-memory file system before each test
beforeEach(() => {
  vol.reset();
  vol.mkdirSync(MOCK_TMP_DIR, { recursive: true });
});

// Mock performance monitoring
global.performance = {
  mark: jest.fn(),
  measure: jest.fn(),
  now: jest.fn(() => Date.now())
};

// Test utilities for document processing
global.testUtils = {
  createMockDocument: (overrides = {}) => ({
    id: `test-doc-${Date.now()}`,
    name: 'test-document.pdf',
    type: 'application/pdf',
    size: 1024,
    content: 'Mock document content for testing',
    ...overrides
  }),

  createMockAnalysisResult: (overrides = {}) => ({
    category: 'Test',
    purpose: 'Testing document analysis',
    keywords: ['test', 'mock', 'document'],
    confidence: 0.85,
    suggestedFolder: 'Test/Documents',
    extractedDate: '2024',
    ...overrides
  }),

  waitForAsync: (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms)),

  generateLargeContent: (sizeKB = 100) => {
    const chunks = sizeKB;
    return Array.from({ length: chunks }, (_, i) => `Mock content chunk ${i + 1} `.repeat(50)).join(
      '\n'
    );
  }
};

// Performance testing utilities
global.performanceUtils = {
  startTimer: () => {
    const start = process.hrtime.bigint();
    return () => {
      const end = process.hrtime.bigint();
      return Number(end - start) / 1000000; // Convert to milliseconds
    };
  },

  measureMemory: () => process.memoryUsage(),

  trackResourceUsage: () => {
    const startMemory = process.memoryUsage();
    const startTime = process.hrtime.bigint();

    return () => {
      const endMemory = process.memoryUsage();
      const endTime = process.hrtime.bigint();

      return {
        memoryDelta: {
          heapUsed: endMemory.heapUsed - startMemory.heapUsed,
          heapTotal: endMemory.heapTotal - startMemory.heapTotal,
          external: endMemory.external - startMemory.external
        },
        timeElapsed: Number(endTime - startTime) / 1000000 // milliseconds
      };
    };
  }
};

// Test data generators
global.testDataGenerators = {
  invoice: () => ({
    content: `
      INVOICE #${Math.floor(Math.random() * 10000)}
      Date: ${new Date().toISOString().split('T')[0]}
      Amount: $${(Math.random() * 5000 + 100).toFixed(2)}
      Due Date: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
      Payment Terms: Net 30
    `,
    expectedCategory: 'Financial',
    expectedFolder: 'Financial/Invoices'
  }),

  contract: () => ({
    content: `
      SERVICE AGREEMENT
      Date: ${new Date().toISOString().split('T')[0]}
      Between: Company A and Company B
      Terms: Software development services
      Duration: 12 months
      Value: $${(Math.random() * 50000 + 10000).toFixed(2)}
    `,
    expectedCategory: 'Legal',
    expectedFolder: 'Legal/Contracts'
  }),

  report: () => ({
    content: `
      PROJECT STATUS REPORT
      Date: ${new Date().toISOString().split('T')[0]}
      Project: Test Project ${Math.floor(Math.random() * 100)}
      Progress: ${Math.floor(Math.random() * 100)}% complete
      Budget: On track
      Timeline: Meeting milestones
    `,
    expectedCategory: 'Project',
    expectedFolder: 'Projects/Reports'
  })
};

// NOTE: The former `global.mockLlamaService` was dead code — it was exposed
// here with a default "successful Financial/Invoice analysis" response, but
// every test file creates its own local LlamaService mock (see
// jest.mock('.../LlamaService', ...) in test/**/*.test.js). Relying on an
// implicit global default risked tests passing by coincidence rather than by
// exercising the subject-under-test's handling of analysis data. Removed on
// purpose: tests now opt into success explicitly via their own mocks.

// Cleanup between tests
beforeEach(() => {
  jest.clearAllMocks();
  vol.reset(); // Reset the in-memory file system
  vol.mkdirSync(MOCK_TMP_DIR, { recursive: true });
  global.documentStore = [];
  global.processingQueue = [];
  global.stateListeners = [];
  global.progressListeners = [];
});

afterEach(() => {
  const registry = global.__testTimerRegistry;
  if (!registry) return;
  const timeouts = Array.from(registry.timeouts);
  const intervals = Array.from(registry.intervals);
  const clearTimeoutSafe =
    typeof global.clearTimeout === 'function' ? global.clearTimeout : nodeClearTimeout;
  const clearIntervalSafe =
    typeof global.clearInterval === 'function' ? global.clearInterval : nodeClearInterval;
  timeouts.forEach((timer) => clearTimeoutSafe(timer));
  intervals.forEach((timer) => clearIntervalSafe(timer));
  registry.timeouts.clear();
  registry.intervals.clear();
  jest.useRealTimers();
});

// Test environment validation
beforeAll(() => {
  console.log('🧪 Stratosort Test Environment Initialized');
  console.log('📋 Test utilities available:', Object.keys(global.testUtils));
  console.log('⚡ Performance monitoring enabled');
});

afterAll(async () => {
  // FIX: Shutdown ServiceContainer to clean up all registered services
  // Services like SmartFolderWatcher and vector DB have intervals/connections
  const containerPath = require.resolve('../src/main/services/ServiceContainer');
  if (require.cache[containerPath]) {
    try {
      const { container, SHUTDOWN_ORDER } = require('../src/main/services/ServiceContainer');
      if (container && typeof container.shutdown === 'function') {
        await container.shutdown(SHUTDOWN_ORDER);
      }
    } catch {
      // Safe to ignore cleanup errors
    }
  }

  console.log('✅ All Stratosort tests completed');
  console.log('🧹 Test environment cleaned up');
});
