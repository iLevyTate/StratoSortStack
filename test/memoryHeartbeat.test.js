/**
 * Tests for the memory heartbeat sampler — per-sample diagnostics with
 * hysteresis on the system-pressure warning so a sustained-high-memory
 * session logs one warn per episode instead of one every 15 seconds
 * (production: 2,568 warn lines in a single session).
 */

const { createMemoryPressureSampler } = require('../src/main/core/memoryHeartbeat');

describe('createMemoryPressureSampler', () => {
  function createHarness() {
    const logger = { info: jest.fn(), warn: jest.fn() };
    let freePct = 100;
    const sampler = createMemoryPressureSampler({
      logger,
      processApi: { memoryUsage: () => ({ rss: 70 * 1024 * 1024, heapUsed: 45 * 1024 * 1024 }) },
      osApi: {
        totalmem: () => 16000 * 1024 * 1024,
        freemem: () => Math.round(16000 * 1024 * 1024 * (freePct / 100))
      }
    });
    return {
      logger,
      sampleAtUsedPct(usedPct) {
        freePct = 100 - usedPct;
        sampler();
      }
    };
  }

  test('warns once per pressure episode, not per sample', () => {
    const { logger, sampleAtUsedPct } = createHarness();

    sampleAtUsedPct(84); // below threshold
    sampleAtUsedPct(90); // upward transition -> warn
    sampleAtUsedPct(92); // still high -> no second warn
    sampleAtUsedPct(94); // still high -> no third warn

    const warns = logger.warn.mock.calls.filter(([msg]) => /pressure high/i.test(msg));
    expect(warns).toHaveLength(1);
  });

  test('logs a recovery line when pressure drops below the low watermark', () => {
    const { logger, sampleAtUsedPct } = createHarness();

    sampleAtUsedPct(90); // warn
    sampleAtUsedPct(82); // between watermarks -> no recovery yet
    expect(logger.info.mock.calls.filter(([msg]) => /recovered/i.test(msg))).toHaveLength(0);

    sampleAtUsedPct(75); // below low watermark -> recovery
    expect(logger.info.mock.calls.filter(([msg]) => /recovered/i.test(msg))).toHaveLength(1);

    // A second episode warns again
    sampleAtUsedPct(91);
    const warns = logger.warn.mock.calls.filter(([msg]) => /pressure high/i.test(msg));
    expect(warns).toHaveLength(2);
  });

  test('every sample logs exactly one line with the memory fields', () => {
    const { logger, sampleAtUsedPct } = createHarness();

    sampleAtUsedPct(84);
    sampleAtUsedPct(90);
    sampleAtUsedPct(92);
    sampleAtUsedPct(75);

    const totalLines = logger.info.mock.calls.length + logger.warn.mock.calls.length;
    expect(totalLines).toBe(4);

    const [, fields] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({
      rssMB: 70,
      heapUsedMB: 45,
      sysTotalMB: 16000,
      sysUsedPct: 90
    });
  });

  test('never throws when os APIs fail', () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const sampler = createMemoryPressureSampler({
      logger,
      processApi: {
        memoryUsage: () => {
          throw new Error('boom');
        }
      },
      osApi: { totalmem: () => 0, freemem: () => 0 }
    });

    expect(() => sampler()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sample failed'),
      expect.objectContaining({ error: 'boom' })
    );
  });
});
