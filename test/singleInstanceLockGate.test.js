jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };

  return {
    logger,
    createLogger: jest.fn(() => logger)
  };
});

describe('singleInstanceLockGate', () => {
  let gate;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    ({ logger } = require('../src/shared/logger'));
    gate = require('../src/main/core/singleInstanceLockGate');
  });

  test('skips the lock for packaged macOS 12 builds', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'darwin',
        isPackaged: true,
        systemVersion: '12.7.6',
        logger
      })
    ).toBe(false);
  });

  test('skips the lock for packaged macOS 13 builds', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'darwin',
        isPackaged: true,
        systemVersion: '13.6',
        logger
      })
    ).toBe(false);
  });

  test('keeps the lock enabled for packaged macOS 14 builds', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'darwin',
        isPackaged: true,
        systemVersion: '14.3.1',
        logger
      })
    ).toBe(true);
  });

  test('keeps the lock enabled on non-macOS platforms', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'win32',
        isPackaged: true,
        systemVersion: '10.0.26200',
        logger
      })
    ).toBe(true);
  });

  test('keeps the lock enabled for unpackaged macOS builds', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'darwin',
        isPackaged: false,
        systemVersion: '12.7.6',
        logger
      })
    ).toBe(true);
  });

  test('fails safe to the lock when the macOS version is malformed', () => {
    expect(
      gate.shouldUseSingleInstanceLock({
        platform: 'darwin',
        isPackaged: true,
        systemVersion: 'Monterey',
        logger
      })
    ).toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      '[STARTUP] Unable to parse macOS version for single-instance workaround; leaving lock enabled',
      expect.objectContaining({ systemVersion: 'Monterey' })
    );
  });
});
