/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { useMoveFilesToFolder } from '../../../../src/renderer/components/search/hooks/useMoveFilesToFolder';

jest.mock('../../../../src/shared/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

describe('useMoveFilesToFolder', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  const run = async (filePaths, opts) => {
    const { result } = renderHook(() => useMoveFilesToFolder());
    return result.current(filePaths, opts);
  };

  test('sends the whole selection as one batch_move and counts rows main reports (UR-04)', async () => {
    const performOperation = jest.fn().mockResolvedValue({
      success: false,
      moved: 1,
      failed: 1,
      results: [
        { success: true, source: '/a/one.txt', destination: '/dest/one.txt' },
        { success: false, source: '/a/two.txt', destination: '/dest/two.txt', error: 'EEXIST' }
      ]
    });
    window.electronAPI = {
      files: {
        selectDirectory: jest.fn().mockResolvedValue({ success: true, path: '/dest' }),
        performOperation
      }
    };

    const { moved, failed, destFolder } = await run(['/a/one.txt', '/a/two.txt']);

    expect(destFolder).toBe('/dest');
    expect(moved).toBe(1);
    expect(failed).toBe(1);
    expect(performOperation).toHaveBeenCalledTimes(1);
    expect(performOperation).toHaveBeenCalledWith({
      type: 'batch_move',
      label: 'Move files',
      operations: [
        { source: '/a/one.txt', destination: '/dest/one.txt' },
        { source: '/a/two.txt', destination: '/dest/two.txt' }
      ]
    });
  });

  test('a fulfilled-but-empty response counts every file as failed [F-171]', async () => {
    window.electronAPI = {
      files: {
        selectDirectory: jest.fn().mockResolvedValue({ success: true, path: '/dest' }),
        // A stale preload whose method exists but returns nothing.
        performOperation: jest.fn().mockResolvedValue(undefined)
      }
    };

    const { moved, failed } = await run(['/a/one.txt', '/a/two.txt']);

    expect(moved).toBe(0);
    expect(failed).toBe(2);
  });

  test('a missing performOperation bridge reports failures, not "Moved N file(s)" [F-171]', async () => {
    window.electronAPI = {
      files: {
        selectDirectory: jest.fn().mockResolvedValue({ success: true, path: '/dest' })
        // performOperation absent — optional chaining fulfills with undefined.
      }
    };

    const { moved, failed } = await run(['/a/one.txt']);

    expect(moved).toBe(0);
    expect(failed).toBe(1);
  });

  test('cancelled directory picker attempts no moves', async () => {
    const performOperation = jest.fn();
    window.electronAPI = {
      files: {
        selectDirectory: jest.fn().mockResolvedValue({ success: false }),
        performOperation
      }
    };

    const { moved, failed, destFolder } = await run(['/a/one.txt']);

    expect(destFolder).toBeNull();
    expect(moved).toBe(0);
    expect(failed).toBe(0);
    expect(performOperation).not.toHaveBeenCalled();
  });
});
