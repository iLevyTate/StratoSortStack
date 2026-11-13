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

describe('createMemoryPressureSampler: available memory and other processes', () => {
  const GiB = 1024 * 1024 * 1024;
  const MiB = 1024 * 1024;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeSampler(overrides = {}) {
    const logger = { info: jest.fn(), warn: jest.fn() };
    let clock = 0;
    const sampler = createMemoryPressureSampler({
      logger,
      processApi: { memoryUsage: () => ({ rss: 70 * MiB, heapUsed: 45 * MiB }) },
      osApi: { totalmem: () => 24 * GiB, freemem: () => 100 * MiB },
      now: () => clock,
      ...overrides
    });
    return {
      logger,
      tick() {
        clock += 15000;
        sampler();
      },
      lastFields() {
        const calls = [...logger.info.mock.calls, ...logger.warn.mock.calls];
        return calls.at(-1)[1];
      }
    };
  }

  test('system use comes from available memory, not free pages', () => {
    const { logger, tick, lastFields } = makeSampler({ peekAvailable: () => 12 * GiB });
    tick();
    expect(lastFields()).toMatchObject({ sysUsedPct: 50, sysAvailableMB: 12288, sysFreeMB: 100 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('sums every Electron process into appProcessesMB', () => {
    const { tick, lastFields } = makeSampler({
      peekAvailable: () => 12 * GiB,
      getAppMetrics: () => [
        { memory: { workingSetSize: 100000 } },
        { memory: { workingSetSize: 50000 } }
      ]
    });
    tick();
    expect(lastFields().appProcessesMB).toBe(146);
  });

  test('swap in use is logged from the next tick on', async () => {
    const { tick, lastFields, logger } = makeSampler({
      peekAvailable: () => 12 * GiB,
      readSwapUsedMB: () => Promise.resolve(8814)
    });
    tick();
    expect(lastFields().swapUsedMB).toBeNull();
    await flush();
    tick();
    tick(); // nothing moved: the swap figure rides along on the next line
    await flush();
    // Force a line by waiting out the quiet interval.
    for (let i = 0; i < 20; i++) tick();
    expect(logger.info.mock.calls.at(-1)[1].swapUsedMB).toBe(8814);
  });

  test('a failing process reader leaves visionRssMB null and never warns', async () => {
    const { tick, lastFields, logger } = makeSampler({
      peekAvailable: () => 12 * GiB,
      getVisionPid: () => 4242,
      readRssKb: () => {
        throw new Error('ps missing');
      },
      getAppMetrics: () => {
        throw new Error('not ready');
      }
    });
    tick();
    await flush();
    tick();
    expect(lastFields()).toMatchObject({ visionRssMB: null, appProcessesMB: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('no vision process means no probe and a null figure', async () => {
    const readRssKb = jest.fn();
    const { tick, lastFields } = makeSampler({
      peekAvailable: () => 12 * GiB,
      getVisionPid: () => null,
      readRssKb
    });
    tick();
    await flush();
    expect(readRssKb).not.toHaveBeenCalled();
    expect(lastFields().visionRssMB).toBeNull();
  });

  test('a 20% rise in the vision process writes a line before the quiet interval', async () => {
    let visionKb = 1000 * 1024;
    const { tick, logger } = makeSampler({
      peekAvailable: () => 12 * GiB,
      getVisionPid: () => 4242,
      readRssKb: () => Promise.resolve(visionKb)
    });
    tick(); // first line; starts the first probe
    await flush();
    tick(); // vision appeared (null -> 1000): a line
    await flush();
    expect(logger.info.mock.calls.at(-1)[1].visionRssMB).toBe(1000);
    const lines = logger.info.mock.calls.length;

    tick(); // unchanged: quiet
    await flush();
    expect(logger.info.mock.calls.length).toBe(lines);

    visionKb = 1200 * 1024;
    tick(); // kicks the probe that sees 1200
    await flush();
    tick();
    expect(logger.info.mock.calls.length).toBe(lines + 1);
    expect(logger.info.mock.calls.at(-1)[1].visionRssMB).toBe(1200);
  });
});
