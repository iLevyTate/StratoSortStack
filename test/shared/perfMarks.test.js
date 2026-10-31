/**
 * Unit tests for the shared perfMarks wrapper.
 *
 * The wrapper is intentionally defensive — it runs in main, preload,
 * renderer, and worker-thread contexts and must never throw. These tests
 * pin that contract.
 */

const perfMarks = require('../../src/shared/perfMarks');

describe('shared/perfMarks', () => {
  afterEach(() => {
    perfMarks.clearMarks();
    perfMarks.clearMeasures();
  });

  test('records marks and measures when performance API is available', () => {
    expect(perfMarks.isEnabled()).toBe(true);

    perfMarks.mark('stratotest:a');
    // A tiny busy-wait so the duration from mark-a -> mark-b is > 0 on
    // every OS (Windows' perf.now() has a ~1ms floor).
    const deadline = Date.now() + 5;
    while (Date.now() < deadline) {
      /* spin */
    }
    perfMarks.mark('stratotest:b');

    const duration = perfMarks.measure('stratotest:ab', 'stratotest:a', 'stratotest:b');
    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  test('is a no-op for invalid mark names', () => {
    expect(() => perfMarks.mark('')).not.toThrow();
    expect(() => perfMarks.mark(undefined)).not.toThrow();
    expect(() => perfMarks.mark(null)).not.toThrow();
  });

  test('measure returns null when start mark is missing', () => {
    const out = perfMarks.measure(
      'stratotest:missing-start',
      'stratotest:does-not-exist',
      'stratotest:also-missing'
    );
    // `measure` returns `null` on failure rather than throwing so callers
    // can treat instrumentation as fire-and-forget.
    expect(out).toBeNull();
  });

  test('measureAndLog emits a structured debug line with a rounded duration', () => {
    perfMarks.mark('stratotest:ml-a');
    const deadline = Date.now() + 2;
    while (Date.now() < deadline) {
      /* spin */
    }
    perfMarks.mark('stratotest:ml-b');

    const debugSpy = jest.fn();
    const duration = perfMarks.measureAndLog(
      'stratotest:ml-span',
      'stratotest:ml-a',
      'stratotest:ml-b',
      { debug: debugSpy }
    );

    expect(typeof duration).toBe('number');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [, payload] = debugSpy.mock.calls[0];
    expect(payload).toMatchObject({ name: 'stratotest:ml-span' });
    expect(typeof payload.durationMs).toBe('number');
    // Rounded to two decimals.
    expect(Math.round(payload.durationMs * 100) / 100).toBe(payload.durationMs);
  });

  test('measureAndLog emits at info when asked, leaving debug untouched', () => {
    perfMarks.mark('stratotest:ml-info-a');
    perfMarks.mark('stratotest:ml-info-b');

    const logger = { debug: jest.fn(), info: jest.fn() };
    const duration = perfMarks.measureAndLog(
      'stratotest:ml-info-span',
      'stratotest:ml-info-a',
      'stratotest:ml-info-b',
      logger,
      { level: 'info' }
    );

    expect(typeof duration).toBe('number');
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('[perf]', {
      name: 'stratotest:ml-info-span',
      durationMs: expect.any(Number)
    });
  });

  test('measureAndLog defaults to debug and ignores an unsupported level method', () => {
    perfMarks.mark('stratotest:ml-default-a');
    perfMarks.mark('stratotest:ml-default-b');

    const logger = { debug: jest.fn(), info: jest.fn() };
    perfMarks.measureAndLog(
      'stratotest:ml-default-span',
      'stratotest:ml-default-a',
      'stratotest:ml-default-b',
      logger
    );
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();

    // A logger without the requested method still measures, just quietly.
    const debugOnly = { debug: jest.fn() };
    const duration = perfMarks.measureAndLog(
      'stratotest:ml-default-span-2',
      'stratotest:ml-default-a',
      'stratotest:ml-default-b',
      debugOnly,
      { level: 'info' }
    );
    expect(typeof duration).toBe('number');
    expect(debugOnly.debug).not.toHaveBeenCalled();
  });

  test('measureAndLog swallows logger failures', () => {
    perfMarks.mark('stratotest:ml-safe-a');
    perfMarks.mark('stratotest:ml-safe-b');
    const badLogger = {
      debug: () => {
        throw new Error('logger boom');
      }
    };
    expect(() =>
      perfMarks.measureAndLog(
        'stratotest:ml-safe-span',
        'stratotest:ml-safe-a',
        'stratotest:ml-safe-b',
        badLogger
      )
    ).not.toThrow();
  });

  test('measureAndLog returns null without logging when measure fails', () => {
    const debugSpy = jest.fn();
    const duration = perfMarks.measureAndLog(
      'stratotest:ml-missing',
      'stratotest:missing-start',
      'stratotest:missing-end',
      { debug: debugSpy }
    );
    expect(duration).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test('never throws even when underlying calls fail', () => {
    const perfObj = global.performance;
    if (!perfObj || typeof perfObj.mark !== 'function') {
      // Sanity: if the runtime has no performance API at all, just verify
      // the wrapper stays quiet. This path is exercised in older Node /
      // minimal test harnesses that don't polyfill perf_hooks.
      expect(() => perfMarks.mark('stratotest:safe')).not.toThrow();
      return;
    }

    const originalMark = perfObj.mark;
    perfObj.mark = () => {
      throw new Error('mark blew up');
    };
    try {
      expect(() => perfMarks.mark('stratotest:safe')).not.toThrow();
    } finally {
      perfObj.mark = originalMark;
    }
  });
});
