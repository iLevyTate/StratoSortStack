/**
 * @jest-environment jsdom
 */

import { fetchAnalysisHistoryPages } from '../src/renderer/utils/analysisHistoryFetch';
import { createIpcValidator } from '../src/preload/ipcValidator';

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

const TOO_LARGE = { success: false, error: 'too large', reason: 'payload-too-large' };

describe('fetchAnalysisHistoryPages - page over the IPC size cap', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  test('retries the same offset with a smaller page instead of stopping', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    // Any request for more than 2 entries is over the cap.
    const get = jest.fn(async ({ limit, offset }) =>
      limit > 2 ? TOO_LARGE : entries.slice(offset, offset + limit)
    );
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 8, maxEntries: 100 });

    expect(result).toEqual(entries);
    expect(get).toHaveBeenNthCalledWith(1, { limit: 8, offset: 0 });
    expect(get).toHaveBeenNthCalledWith(2, { limit: 4, offset: 0 });
    expect(get).toHaveBeenNthCalledWith(3, { limit: 2, offset: 0 });
  });

  test('skips a single entry that is over the cap on its own', async () => {
    const entries = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const get = jest.fn(async ({ limit, offset }) =>
      offset === 1 ? TOO_LARGE : entries.slice(offset, offset + limit)
    );
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 1, maxEntries: 100 });

    expect(result).toEqual([{ id: 0 }, { id: 2 }]);
  });

  test('grows back to the full page size after skipping one oversized entry', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    // Only entry 1 is over the cap, so any page that includes it is too.
    const get = jest.fn(async ({ limit, offset }) =>
      offset <= 1 && offset + limit > 1 ? TOO_LARGE : entries.slice(offset, offset + limit)
    );
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 4, maxEntries: 100 });

    expect(result).toEqual(entries.filter((e) => e.id !== 1));
    const calls = get.mock.calls.map(([args]) => args);
    const afterSkip = calls.filter((c) => c.offset >= 2);
    // Reads past the bad entry start small and double back to the original
    // page size, not one entry per call.
    expect(afterSkip.length).toBeGreaterThan(0);
    expect(afterSkip[afterSkip.length - 1].limit).toBe(4);
    expect(calls.length).toBeLessThan(12);
  });

  test('a run of oversized entries costs one call each, not a full-size retry each', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ id: i }));
    // Entries 2-21 are each over the cap on their own.
    const isLarge = (e) => e.id >= 2 && e.id <= 21;
    const get = jest.fn(async ({ limit, offset }) => {
      const page = entries.slice(offset, offset + limit);
      return page.some(isLarge) ? TOO_LARGE : page;
    });
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 64, maxEntries: 100 });

    expect(result).toEqual(entries.filter((e) => !isLarge(e)));
    // 20 skips at one call each plus the shrink and the regrowth; resetting
    // to 64 after each skip would cost about 7 calls per skipped entry.
    expect(get.mock.calls.length).toBeLessThan(40);
  });

  test('grows the page back after a run of large entries ends', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    // Entries 0-3 are large: a page holding more than one of them is too big.
    const get = jest.fn(async ({ limit, offset }) => {
      const largeInPage = entries.slice(offset, offset + limit).filter((e) => e.id < 4).length;
      return largeInPage > 1 ? TOO_LARGE : entries.slice(offset, offset + limit);
    });
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 8, maxEntries: 100 });

    expect(result).toEqual(entries);
    const limits = get.mock.calls.map(([args]) => args.limit);
    expect(limits[limits.length - 1]).toBe(8);
  });

  test('recognizes the response the preload validator sends for an oversized page', async () => {
    // Pins the reason string shared by the preload validator and this
    // fetcher; the renderer cannot import the preload module at runtime.
    const { validateResult } = createIpcValidator();
    const hugeText = 'x'.repeat(600000);
    const entries = [{ id: 0 }, { id: 1, analysis: { extractedText: hugeText } }, { id: 2 }];
    const get = jest.fn(async ({ limit, offset }) =>
      validateResult(entries.slice(offset, offset + limit), 'analysis-history:get')
    );
    window.electronAPI = { analysisHistory: { get } };

    const result = await fetchAnalysisHistoryPages({ pageSize: 4, maxEntries: 100 });

    expect(result).toEqual([{ id: 0 }, { id: 2 }]);
  });
});
