/**
 * @jest-environment node
 */
/**
 * Coordinated startup (StartupManager services, then ServiceIntegration) on a
 * large library can outlast the soft timeout. The soft timeout reports a
 * degraded start so the UI can say so, but it must not tear down a startup
 * that is still making progress; only the hard cap (or a quit) aborts. When
 * a late startup finishes, the degraded flag clears and the deferred wiring
 * runs exactly once.
 */
jest.mock('electron', () => require('./loadSimpleMain').electronMockFactory());
jest.mock('chokidar', () => ({ watch: jest.fn() }));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/main/core/userDataLock', () =>
  require('./loadSimpleMain').userDataLockMockFactory()
);
jest.mock('../../../src/main/core/createWindow', () =>
  require('./loadSimpleMain').createWindowMockFactory()
);

const { loadSimpleMain } = require('./loadSimpleMain');
const { TIMEOUTS } = require('../../../src/shared/performanceConstants');

const SOFT_MS = TIMEOUTS.COORDINATED_STARTUP_SOFT;
const HARD_MS = TIMEOUTS.COORDINATED_STARTUP_HARD_CAP;
const FAILURE_CODE = 'startup.coordinated-failure';
const STILL_STARTING_CODE = 'startup.still-starting';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStartupManager(servicesDone) {
  return {
    startup: jest.fn(async ({ signal }) => {
      // Like StartupManager: an abort while services load fails startup.
      const aborted = new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Startup aborted')), {
          once: true
        });
      });
      return Promise.race([servicesDone.promise, aborted]);
    }),
    abortStartup: jest.fn()
  };
}

function makeIntegration() {
  return {
    initialized: false,
    initialize: jest.fn(async function initialize() {
      this.initialized = true;
    }),
    configureSmartFolderWatcher: jest.fn(),
    configureDownloadWatcher: jest.fn(),
    configureLearningFeedback: jest.fn(),
    runLearningStartupScan: jest.fn().mockResolvedValue(undefined)
  };
}

function raiseFailureFlag(tracker) {
  tracker.raise({
    code: FAILURE_CODE,
    subsystem: 'startup',
    severity: 'error',
    message: 'AI services did not fully start'
  });
}

let harness;

beforeAll(() => {
  harness = loadSimpleMain();
});

afterAll(() => {
  harness.dispose();
});

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('runCoordinatedStartupInBackground timeouts', () => {
  test('keeps the soft timeout shorter than the hard cap', () => {
    expect(SOFT_MS).toBe(45000);
    expect(HARD_MS).toBeGreaterThan(SOFT_MS);
  });

  test('a startup still running at the soft timeout is reported degraded but keeps going', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    await jest.advanceTimersByTimeAsync(SOFT_MS);
    const result = await resultPromise;

    expect(result.degraded).toBe(true);
    expect(startupManager.abortStartup).not.toHaveBeenCalled();
    const { signal } = startupManager.startup.mock.calls[0][0];
    expect(signal.aborted).toBe(false);

    // Services finish five seconds later; service integration still runs.
    await jest.advanceTimersByTimeAsync(5_000);
    servicesDone.resolve({ success: true });
    await jest.advanceTimersByTimeAsync(0);

    expect(integration.initialize).toHaveBeenCalledTimes(1);
    expect(integration.initialize.mock.calls[0][0].signal.aborted).toBe(false);
  });

  test('the late completion resolves with the services result', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    await jest.advanceTimersByTimeAsync(SOFT_MS);
    const result = await resultPromise;
    expect(result.timedOut).toBe(true);

    servicesDone.resolve({ success: true, services: {} });
    await expect(result.lateCompletion).resolves.toEqual({ success: true, services: {} });
    expect(integration.initialized).toBe(true);
  });

  test('the hard cap aborts a startup that never finishes', async () => {
    const servicesDone = deferred(); // never resolves
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    await jest.advanceTimersByTimeAsync(SOFT_MS);
    const result = await resultPromise;
    expect(startupManager.abortStartup).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(HARD_MS - SOFT_MS);
    await expect(result.lateCompletion).resolves.toBeNull();
    expect(startupManager.abortStartup).toHaveBeenCalledTimes(1);
    expect(startupManager.startup.mock.calls[0][0].signal.aborted).toBe(true);
    expect(integration.initialize).not.toHaveBeenCalled();
  });

  test('a startup that finishes in time returns its result and nothing aborts later', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    servicesDone.resolve({ success: true });
    const result = await resultPromise;

    expect(result).toEqual({ success: true });
    expect(integration.initialize).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HARD_MS);
    expect(startupManager.abortStartup).not.toHaveBeenCalled();
  });

  test('quitting aborts a running startup before service integration', async () => {
    expect(harness.mod.abortCoordinatedStartup('Application quitting')).toBe(false);

    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();
    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );

    expect(harness.mod.abortCoordinatedStartup('Application quitting')).toBe(true);
    const result = await resultPromise;

    expect(result.degraded).toBe(true);
    expect(startupManager.abortStartup).toHaveBeenCalledWith('Application quitting');
    expect(integration.initialize).not.toHaveBeenCalled();
    // Nothing is left running to abort.
    expect(harness.mod.abortCoordinatedStartup('Application quitting')).toBe(false);
  });
});

describe('finishing coordinated startup after the soft timeout', () => {
  let tracker;

  beforeAll(() => {
    tracker = require('../../../src/main/services/DegradedStateTracker').getInstance();
  });

  test('a late failure keeps the degraded flag and wires nothing', async () => {
    raiseFailureFlag(tracker);
    const integration = makeIntegration();

    await expect(
      harness.mod.finishLateCoordinatedStartup({}, integration, Promise.resolve(null), {})
    ).resolves.toBe(false);
    expect(tracker.isRaised(FAILURE_CODE)).toBe(true);
    expect(integration.configureSmartFolderWatcher).not.toHaveBeenCalled();
    tracker.clear(FAILURE_CODE);
  });

  test('clears the degraded flag and applies the deferred wiring exactly once', async () => {
    raiseFailureFlag(tracker);
    const integration = makeIntegration();
    integration.initialized = true;
    const startupManager = { getServiceStatus: jest.fn(() => ({ services: {} })) };

    await expect(
      harness.mod.finishLateCoordinatedStartup(
        startupManager,
        integration,
        Promise.resolve({ success: true }),
        {}
      )
    ).resolves.toBe(true);

    expect(tracker.isRaised(FAILURE_CODE)).toBe(false);
    expect(integration.configureSmartFolderWatcher).toHaveBeenCalledTimes(1);
    expect(integration.configureDownloadWatcher).toHaveBeenCalledTimes(1);
    expect(integration.configureLearningFeedback).toHaveBeenCalledTimes(1);

    // A second completion path must not wire the watchers twice.
    await expect(
      harness.mod.completeDeferredStartup(startupManager, integration, { success: true }, {})
    ).resolves.toBe(false);
    expect(integration.configureSmartFolderWatcher).toHaveBeenCalledTimes(1);
  });
});

describe('service integration that fails or is aborted after the soft timeout', () => {
  let tracker;

  beforeAll(() => {
    tracker = require('../../../src/main/services/DegradedStateTracker').getInstance();
  });

  afterEach(() => {
    tracker.clear(FAILURE_CODE);
    tracker.clear(STILL_STARTING_CODE);
  });

  // Like ServiceIntegration: an abort or unexpected error inside initialize()
  // is caught and resolved as { success: false } with initialized left false.
  function makeIntegrationThatResolvesFailureOnAbort() {
    const integration = makeIntegration();
    integration.initialize = jest.fn(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              integration.initialized = false;
              resolve({ success: false, errors: [{ service: 'serviceIntegration' }] });
            },
            { once: true }
          );
        })
    );
    return integration;
  }

  test('a hard-cap abort during service integration resolves the late completion as a failure', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegrationThatResolvesFailureOnAbort();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    await jest.advanceTimersByTimeAsync(SOFT_MS);
    const result = await resultPromise;
    expect(result.timedOut).toBe(true);

    servicesDone.resolve({ success: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(integration.initialize).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HARD_MS - SOFT_MS);
    await expect(result.lateCompletion).resolves.toBeNull();
  });

  test('a late service-integration failure shows the error banner and wires nothing', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegrationThatResolvesFailureOnAbort();

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    await jest.advanceTimersByTimeAsync(SOFT_MS);
    const result = await resultPromise;
    harness.mod.raiseCoordinatedStartupNotice(result);

    const finished = harness.mod.finishLateCoordinatedStartup(
      startupManager,
      integration,
      result.lateCompletion,
      {}
    );
    servicesDone.resolve({ success: true });
    await jest.advanceTimersByTimeAsync(HARD_MS - SOFT_MS);

    await expect(finished).resolves.toBe(false);
    expect(tracker.isRaised(FAILURE_CODE)).toBe(true);
    expect(tracker.isRaised(STILL_STARTING_CODE)).toBe(false);
    expect(integration.configureSmartFolderWatcher).not.toHaveBeenCalled();
  });

  test('service integration that resolves without initializing fails an in-time startup', async () => {
    const servicesDone = deferred();
    const startupManager = makeStartupManager(servicesDone);
    const integration = makeIntegration();
    integration.initialize = jest.fn(async () => ({ success: false }));

    const resultPromise = harness.mod.runCoordinatedStartupInBackground(
      startupManager,
      integration
    );
    servicesDone.resolve({ success: true });
    const result = await resultPromise;

    expect(result.degraded).toBe(true);
    expect(result.timedOut).toBeUndefined();
  });
});

describe('the notice shown while a slow startup keeps running', () => {
  let tracker;

  beforeAll(() => {
    tracker = require('../../../src/main/services/DegradedStateTracker').getInstance();
  });

  afterEach(() => {
    tracker.clear(FAILURE_CODE);
    tracker.clear(STILL_STARTING_CODE);
  });

  function flag(code) {
    return tracker.list().find((f) => f.code === code);
  }

  test('a soft timeout shows a still-starting warning, not the restart error', () => {
    harness.mod.raiseCoordinatedStartupNotice({
      degraded: true,
      timedOut: true,
      error: 'Coordinated startup timeout after 45 seconds',
      lateCompletion: Promise.resolve(null)
    });

    expect(tracker.isRaised(FAILURE_CODE)).toBe(false);
    const notice = flag(STILL_STARTING_CODE);
    expect(notice.severity).toBe('warning');
    expect(notice.message).not.toMatch(/restart/i);
  });

  test('a startup that failed outright shows the restart error', () => {
    harness.mod.raiseCoordinatedStartupNotice({ degraded: true, error: 'boom' });

    expect(flag(FAILURE_CODE).severity).toBe('error');
    expect(tracker.isRaised(STILL_STARTING_CODE)).toBe(false);
  });

  test('a healthy startup shows nothing', () => {
    harness.mod.raiseCoordinatedStartupNotice({ success: true });

    expect(tracker.isRaised(FAILURE_CODE)).toBe(false);
    expect(tracker.isRaised(STILL_STARTING_CODE)).toBe(false);
  });

  test('a late success clears the still-starting warning', async () => {
    harness.mod.raiseCoordinatedStartupNotice({ degraded: true, timedOut: true });
    const integration = makeIntegration();
    integration.initialized = true;

    await harness.mod.finishLateCoordinatedStartup(
      { getServiceStatus: jest.fn(() => ({ services: {} })) },
      integration,
      Promise.resolve({ success: true }),
      {}
    );

    expect(tracker.isRaised(STILL_STARTING_CODE)).toBe(false);
    expect(tracker.isRaised(FAILURE_CODE)).toBe(false);
  });

  test('a late failure replaces the warning with the restart error', async () => {
    harness.mod.raiseCoordinatedStartupNotice({ degraded: true, timedOut: true });

    await expect(
      harness.mod.finishLateCoordinatedStartup({}, makeIntegration(), Promise.resolve(null), {})
    ).resolves.toBe(false);

    expect(tracker.isRaised(STILL_STARTING_CODE)).toBe(false);
    expect(flag(FAILURE_CODE).severity).toBe('error');
  });
});
