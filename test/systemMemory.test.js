/**
 * @jest-environment node
 *
 * Available memory per platform. On macOS os.freemem() counts free pages
 * only, so a healthy Mac looks nearly out of memory; the reader uses the
 * kernel's memorystatus level there and os.freemem() everywhere else.
 */

const {
  createAvailableMemoryReader,
  readSwapUsedMB,
  readProcessRssKb,
  parseMemorystatusLevel,
  parseSwapUsedMB
} = require('../src/main/utils/systemMemory');

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function ok(stdout) {
  return jest.fn(async () => ({ status: 0, stdout }));
}

function makeOs({ total = 24 * GiB, free = 100 * MiB } = {}) {
  return { totalmem: jest.fn(() => total), freemem: jest.fn(() => free) };
}

const quietLog = { warn: jest.fn() };

describe('parseMemorystatusLevel', () => {
  test.each([
    ['37\n', 37],
    ['0', 0],
    ['100', 100],
    ['abc', null],
    ['', null],
    ['101', null],
    ['-1', null],
    ['3.5', null]
  ])('%p -> %p', (input, expected) => {
    expect(parseMemorystatusLevel(input)).toBe(expected);
  });
});

describe('parseSwapUsedMB', () => {
  test('reads the used figure in MB', () => {
    expect(
      parseSwapUsedMB('total = 10240.00M  used = 8814.25M  free = 1425.75M  (encrypted)')
    ).toBe(8814);
  });

  test('converts G and returns null for anything else', () => {
    expect(parseSwapUsedMB('total = 4.00G  used = 1.50G  free = 2.50G')).toBe(1536);
    expect(parseSwapUsedMB('nonsense')).toBeNull();
  });
});

describe('createAvailableMemoryReader', () => {
  test('darwin: uses the memorystatus level times total memory', async () => {
    const runCommand = ok('37\n');
    const osApi = makeOs();
    const reader = createAvailableMemoryReader({ platform: 'darwin', osApi, runCommand });

    await expect(reader.read()).resolves.toBe(Math.round(24 * GiB * 0.37));
    expect(runCommand).toHaveBeenCalledWith(
      '/usr/sbin/sysctl',
      ['-n', 'kern.memorystatus_level'],
      expect.objectContaining({ timeout: 1000 })
    );
  });

  test('darwin: a failed probe falls back to free memory and warns once', async () => {
    const runCommand = jest.fn(async () => ({
      status: null,
      stdout: '',
      error: new Error('ENOENT')
    }));
    const log = { warn: jest.fn() };
    const reader = createAvailableMemoryReader({
      platform: 'darwin',
      osApi: makeOs(),
      runCommand,
      cacheMs: 0,
      log
    });

    await expect(reader.read()).resolves.toBe(100 * MiB);
    await expect(reader.read()).resolves.toBe(100 * MiB);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('darwin: unreadable output or a non-zero exit falls back to free memory', async () => {
    const garbled = createAvailableMemoryReader({
      platform: 'darwin',
      osApi: makeOs(),
      runCommand: ok('abc'),
      log: quietLog
    });
    await expect(garbled.read()).resolves.toBe(100 * MiB);

    const exited = createAvailableMemoryReader({
      platform: 'darwin',
      osApi: makeOs(),
      runCommand: jest.fn(async () => ({ status: 1, stdout: '50' })),
      log: quietLog
    });
    await expect(exited.read()).resolves.toBe(100 * MiB);
  });

  test('win32 and linux never start a process and return free memory', async () => {
    for (const platform of ['win32', 'linux']) {
      const runCommand = ok('37');
      const reader = createAvailableMemoryReader({ platform, osApi: makeOs(), runCommand });
      await expect(reader.read()).resolves.toBe(100 * MiB);
      expect(reader.peek()).toBe(100 * MiB);
      expect(runCommand).not.toHaveBeenCalled();
    }
  });

  test('reads within the cache window run the probe once', async () => {
    let clock = 0;
    const runCommand = ok('50');
    const reader = createAvailableMemoryReader({
      platform: 'darwin',
      osApi: makeOs(),
      runCommand,
      now: () => clock
    });

    await reader.read();
    clock += 1500;
    await reader.read();
    expect(runCommand).toHaveBeenCalledTimes(1);

    clock += 1000; // 2.5 s since the reading
    await reader.read();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  test('concurrent reads share one probe', async () => {
    const runCommand = ok('50');
    const reader = createAvailableMemoryReader({ platform: 'darwin', osApi: makeOs(), runCommand });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toBe(12 * GiB);
    expect(b).toBe(12 * GiB);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  test('peek returns free memory until the first reading lands, then the reading', async () => {
    const runCommand = ok('50');
    const reader = createAvailableMemoryReader({ platform: 'darwin', osApi: makeOs(), runCommand });

    expect(reader.peek()).toBe(100 * MiB);
    await reader.read();
    expect(reader.peek()).toBe(12 * GiB);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('readSwapUsedMB', () => {
  test('darwin parses vm.swapusage', async () => {
    const runCommand = ok('total = 10240.00M  used = 8814.25M  free = 1425.75M  (encrypted)\n');
    await expect(readSwapUsedMB({ platform: 'darwin', runCommand })).resolves.toBe(8814);
    expect(runCommand).toHaveBeenCalledWith(
      '/usr/sbin/sysctl',
      ['-n', 'vm.swapusage'],
      expect.any(Object)
    );
  });

  test('other platforms and failures give null', async () => {
    const runCommand = ok('used = 5M');
    await expect(readSwapUsedMB({ platform: 'win32', runCommand })).resolves.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    const failing = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(readSwapUsedMB({ platform: 'darwin', runCommand: failing })).resolves.toBeNull();
  });
});

describe('readProcessRssKb', () => {
  test('darwin and linux read ps output', async () => {
    const runCommand = ok('  2048000\n');
    await expect(readProcessRssKb(4242, { platform: 'darwin', runCommand })).resolves.toBe(2048000);
    expect(runCommand).toHaveBeenCalledWith(
      '/bin/ps',
      ['-o', 'rss=', '-p', '4242'],
      expect.any(Object)
    );
    await expect(readProcessRssKb(4242, { platform: 'linux', runCommand })).resolves.toBe(2048000);
  });

  test('win32, a missing pid, an exited process or a throw give null', async () => {
    const runCommand = ok('100');
    await expect(readProcessRssKb(4242, { platform: 'win32', runCommand })).resolves.toBeNull();
    await expect(readProcessRssKb(null, { platform: 'darwin', runCommand })).resolves.toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    const gone = jest.fn(async () => ({ status: 1, stdout: '' }));
    await expect(
      readProcessRssKb(4242, { platform: 'darwin', runCommand: gone })
    ).resolves.toBeNull();
  });
});
