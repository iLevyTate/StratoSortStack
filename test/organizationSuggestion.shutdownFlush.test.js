/**
 * Quitting right after an organize must not lose what it taught: the service
 * container awaits shutdown(), so shutdown() has to wait for the throttled
 * pattern and memory saves to reach disk.
 */

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => ({ initialize: jest.fn(), getConfig: jest.fn(() => ({})) })
}));

const OrganizationSuggestionService = require('../src/main/services/organization');

function makeService() {
  return new OrganizationSuggestionService({
    vectorDbService: {},
    folderMatchingService: {},
    settingsService: { load: jest.fn().mockResolvedValue({}) }
  });
}

function delayedFlag() {
  const state = { done: false };
  const shutdown = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        state.done = true;
        resolve();
      }, 20);
    });
  return { state, shutdown };
}

describe('OrganizationSuggestionService.shutdown', () => {
  test('waits for the pattern and memory saves to finish', async () => {
    const service = makeService();
    const patterns = delayedFlag();
    const memory = delayedFlag();
    service.persistence.shutdown = patterns.shutdown;
    service.feedbackMemoryStore.shutdown = memory.shutdown;

    await service.shutdown();

    expect(patterns.state.done).toBe(true);
    expect(memory.state.done).toBe(true);
  });

  test('a failing memory save does not stop the pattern save or reject', async () => {
    const service = makeService();
    const patterns = delayedFlag();
    service.persistence.shutdown = patterns.shutdown;
    service.feedbackMemoryStore.shutdown = jest.fn().mockRejectedValue(new Error('disk full'));

    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(patterns.state.done).toBe(true);
  });

  // Later services (the search index's final save) share the same shutdown
  // budget, so a stalled disk write must not hold them up.
  test('gives up on a stalled save after a few seconds and logs it', async () => {
    jest.useFakeTimers();
    try {
      const { logger } = require('../src/shared/logger');
      const warn = jest.spyOn(logger, 'warn');
      const service = makeService();
      service.persistence.shutdown = () => new Promise(() => {});
      service.feedbackMemoryStore.shutdown = jest.fn().mockResolvedValue(undefined);

      let finished = false;
      const done = service.shutdown().then(() => {
        finished = true;
      });
      await jest.advanceTimersByTimeAsync(2000);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1500);
      await done;

      expect(finished).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('gave up waiting'),
        expect.anything()
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('a synchronous throw is contained too', async () => {
    const service = makeService();
    service.persistence.shutdown = () => {
      throw new Error('boom');
    };
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
