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
    let rssMB = 70;
    let clock = 0;
    const sampler = createMemoryPressureSampler({
      logger,
      processApi: {
        memoryUsage: () => ({ rss: rssMB * 1024 * 1024, heapUsed: 45 * 1024 * 1024 })
      },
      osApi: {
        totalmem: () => 16000 * 1024 * 1024,
        freemem: () => Math.round(16000 * 1024 * 1024 * (freePct / 100))
      },
      now: () => clock
    });
    return {
      logger,
      sampleAtUsedPct(usedPct) {
        clock += 15000;
        freePct = 100 - usedPct;
        sampler();
      },
      setRssMB(value) {
        rssMB = value;
      },
      lineCount() {
        return logger.info.mock.calls.length + logger.warn.mock.calls.length;
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

  test('pressure transitions always log, with the memory fields', () => {
    const { logger, sampleAtUsedPct, lineCount } = createHarness();

    sampleAtUsedPct(84); // first sample
    sampleAtUsedPct(90); // warn
    sampleAtUsedPct(92); // still high, barely moved -> quiet
    sampleAtUsedPct(75); // recovery

    expect(lineCount()).toBe(3);

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

  test('a steady session writes one line, then one every five minutes', () => {
    const { sampleAtUsedPct, lineCount } = createHarness();

    sampleAtUsedPct(50);
    expect(lineCount()).toBe(1);

    // 19 more samples at 15 s = 4m45s: nothing moved, nothing logged.
    for (let i = 0; i < 19; i++) sampleAtUsedPct(51);
    expect(lineCount()).toBe(1);

    sampleAtUsedPct(51); // 5 minutes since the last line
    expect(lineCount()).toBe(2);
  });

  test('a move in system memory or in RSS logs straight away', () => {
    const { logger, sampleAtUsedPct, setRssMB, lineCount } = createHarness();

    sampleAtUsedPct(50);
    sampleAtUsedPct(54); // 4 points: quiet
    expect(lineCount()).toBe(1);
    sampleAtUsedPct(55); // 5 points from the last line
    expect(lineCount()).toBe(2);

    setRssMB(76); // under 10% of 70
    sampleAtUsedPct(55);
    expect(lineCount()).toBe(2);
    setRssMB(77); // 10% of 70
    sampleAtUsedPct(55);
    expect(lineCount()).toBe(3);
    expect(logger.info.mock.calls.at(-1)[1]).toMatchObject({ rssMB: 77, sysUsedPct: 55 });
  });
});
