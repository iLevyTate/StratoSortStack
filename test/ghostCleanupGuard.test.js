/**
 * @jest-environment node
 */
const {
  deferGhostCleanup,
  resumeGhostCleanup,
  isGhostCleanupDeferred,
  withGhostCleanupDeferred
} = require('../src/shared/ghostCleanupGuard');

describe('ghostCleanupGuard', () => {
  afterEach(() => {
    while (isGhostCleanupDeferred()) {
      resumeGhostCleanup();
    }
  });

  test('defers while a batch is in flight', () => {
    expect(isGhostCleanupDeferred()).toBe(false);
    deferGhostCleanup();
    expect(isGhostCleanupDeferred()).toBe(true);
    resumeGhostCleanup();
    expect(isGhostCleanupDeferred()).toBe(false);
  });

  test('withGhostCleanupDeferred holds the latch for the callback and releases on resolve', async () => {
    const result = await withGhostCleanupDeferred(async () => {
      expect(isGhostCleanupDeferred()).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(isGhostCleanupDeferred()).toBe(false);
  });

  test('withGhostCleanupDeferred releases the latch when the callback rejects', async () => {
    await expect(
      withGhostCleanupDeferred(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isGhostCleanupDeferred()).toBe(false);
  });
});
