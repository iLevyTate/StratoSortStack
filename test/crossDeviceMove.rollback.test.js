/**
 * Tests for crossDeviceMove rollback fix.
 * Verifies that if source unlink fails after a successful copy,
 * the destination copy is removed to prevent data duplication —
 * EXCEPT when the unlink fails with ENOENT (source already gone),
 * in which case the destination is the only surviving copy and
 * must be preserved.
 *
 * crossDeviceMove stages the copy at `<dest>.stratosort-<ts>-<hex>.tmp`
 * and publishes it via renameNoReplace, so these mocks stub fs.rename
 * (publish step) alongside copyFile/stat/unlink.
 */

const fs = require('fs').promises;
const path = require('path');

jest.mock('../src/shared/logger', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/errors/FileSystemError', () => {
  class FSError extends Error {
    constructor(code, metadata = {}) {
      super(metadata.originalError || code);
      this.code = code;
      this.metadata = metadata;
      this.isFileSystemError = true;
    }
    static fromNodeError(error, context = {}) {
      return new FSError(error.code || 'UNKNOWN', {
        ...context,
        originalError: error.message
      });
    }
  }
  return {
    FileSystemError: FSError,
    AtomicOperationError: FSError,
    IntegrityError: FSError,
    FILE_SYSTEM_ERROR_CODES: {
      SIZE_MISMATCH: 'SIZE_MISMATCH',
      CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH'
    }
  };
});

const { crossDeviceMove } = require('../src/shared/atomicFileOperations');
const { logger } = require('../src/shared/logger');

describe('crossDeviceMove rollback on source-unlink failure', () => {
  const SOURCE = '/mock/source/file.txt';
  const DEST = '/mock/dest/file.txt';

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('rolls back destination when source unlink fails', async () => {
    // copyFile (to the staging name) succeeds
    const copySpy = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    // stat succeeds for verify – sizes match
    jest.spyOn(fs, 'stat').mockResolvedValue({ size: 100 });
    // renameNoReplace preflight: destination is free
    jest
      .spyOn(fs, 'access')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // publish rename (staging -> dest) succeeds
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    // unlink: first call (source delete) fails, second call (dest rollback) succeeds
    const unlinkSpy = jest
      .spyOn(fs, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      .mockResolvedValueOnce(undefined);

    await expect(crossDeviceMove(SOURCE, DEST)).rejects.toThrow();

    // The copy targeted a staging name, never the canonical destination.
    expect(copySpy.mock.calls[0][1]).not.toBe(path.normalize(DEST));
    expect(copySpy.mock.calls[0][1]).toMatch(/\.stratosort-.*\.tmp$/);
    // unlink was called twice: source (failed), then dest (rollback)
    expect(unlinkSpy).toHaveBeenCalledTimes(2);
    expect(unlinkSpy.mock.calls[0][0]).toContain('source');
    expect(unlinkSpy.mock.calls[1][0]).toBe(path.normalize(DEST));
    // Error was logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove source'),
      expect.objectContaining({ source: expect.any(String) })
    );
  });

  // Regression: ENOENT on the source unlink means the source is already gone,
  // so the verified copy at the destination is the ONLY surviving copy. It
  // must be preserved — rolling back here destroyed the user's file.
  test('preserves destination when source unlink fails with ENOENT', async () => {
    jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'stat').mockResolvedValue({ size: 100 });
    // renameNoReplace preflight: destination is free
    jest
      .spyOn(fs, 'access')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    const unlinkSpy = jest
      .spyOn(fs, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(crossDeviceMove(SOURCE, DEST)).resolves.toBeUndefined();

    // Only the source unlink was attempted; the destination was never touched.
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy.mock.calls[0][0]).toContain('source');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('treating move as complete'),
      expect.objectContaining({ destination: expect.any(String) })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('logs error when both source unlink and rollback fail', async () => {
    jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'stat').mockResolvedValue({ size: 100 });
    // renameNoReplace preflight: destination is free
    jest
      .spyOn(fs, 'access')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    jest
      .spyOn(fs, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      .mockRejectedValueOnce(new Error('EBUSY'));

    await expect(crossDeviceMove(SOURCE, DEST)).rejects.toThrow();

    // Both errors were logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove source'),
      expect.any(Object)
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Rollback of destination also failed'),
      expect.any(Object)
    );
  });

  test('succeeds normally when source unlink works', async () => {
    jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'stat').mockResolvedValue({ size: 100 });
    // renameNoReplace preflight: destination is free
    jest
      .spyOn(fs, 'access')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    await expect(crossDeviceMove(SOURCE, DEST)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Cross-device move completed'),
      expect.any(Object)
    );
  });
});
