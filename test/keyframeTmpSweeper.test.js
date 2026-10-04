/**
 * Tests for the startup orphan-keyframe sweep.
 * The sweep walks os.tmpdir() once for `stratosort-keyframes-*` directories
 * older than `maxAgeMs` and removes them. Failures are best-effort.
 */

const {
  sweepOrphanKeyframeDirs,
  KEYFRAME_PREFIX
} = require('../src/main/services/keyframeTmpSweeper');

function makeFakeFs({ entries = [], statResults = {}, rmImpl = null } = {}) {
  const rmCalls = [];
  return {
    readdir: jest.fn(async (_dir, opts) => {
      if (opts?.withFileTypes) {
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => Boolean(e.isDirectory),
          isFile: () => Boolean(e.isFile)
        }));
      }
      return entries.map((e) => e.name);
    }),
    stat: jest.fn(async (p) => {
      const name = p.split(/[/\\]/).pop();
      const r = statResults[name];
      if (!r) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      if (r.throws) throw r.throws;
      return { mtimeMs: r.mtimeMs };
    }),
    rm: jest.fn(async (p, opts) => {
      rmCalls.push({ path: p, opts });
      if (rmImpl) await rmImpl(p);
    }),
    _rmCalls: rmCalls
  };
}

describe('sweepOrphanKeyframeDirs', () => {
  test('removes prefixed directories older than maxAgeMs', async () => {
    const oldEnough = Date.now() - 48 * 60 * 60 * 1000; // 48 h ago
    const fakeFs = makeFakeFs({
      entries: [
        { name: `${KEYFRAME_PREFIX}clip1-aaa`, isDirectory: true },
        { name: `${KEYFRAME_PREFIX}clip2-bbb`, isDirectory: true }
      ],
      statResults: {
        [`${KEYFRAME_PREFIX}clip1-aaa`]: { mtimeMs: oldEnough },
        [`${KEYFRAME_PREFIX}clip2-bbb`]: { mtimeMs: oldEnough }
      }
    });

    const result = await sweepOrphanKeyframeDirs({
      tmpDir: '/tmp',
      fsImpl: fakeFs
    });
    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(fakeFs.rm).toHaveBeenCalledTimes(2);
    expect(fakeFs._rmCalls[0].opts).toMatchObject({ recursive: true, force: true });
  });

  test('leaves recent directories alone (in-flight analysis safety)', async () => {
    const recent = Date.now() - 5 * 60 * 1000; // 5 min ago — analysis still running
    const old = Date.now() - 48 * 60 * 60 * 1000;
    const fakeFs = makeFakeFs({
      entries: [
        { name: `${KEYFRAME_PREFIX}live-aaa`, isDirectory: true },
        { name: `${KEYFRAME_PREFIX}old-bbb`, isDirectory: true }
      ],
      statResults: {
        [`${KEYFRAME_PREFIX}live-aaa`]: { mtimeMs: recent },
        [`${KEYFRAME_PREFIX}old-bbb`]: { mtimeMs: old }
      }
    });

    const result = await sweepOrphanKeyframeDirs({
      tmpDir: '/tmp',
      fsImpl: fakeFs
    });
    expect(result.removed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(fakeFs.rm).toHaveBeenCalledTimes(1);
    expect(fakeFs.rm.mock.calls[0][0]).toMatch(/old-bbb$/);
  });

  test('ignores directories that do not match the keyframe prefix', async () => {
    const fakeFs = makeFakeFs({
      entries: [
        { name: 'something-else', isDirectory: true },
        { name: 'npm-cache-9482', isDirectory: true },
        { name: `${KEYFRAME_PREFIX}target-xx`, isDirectory: true }
      ],
      statResults: {
        [`${KEYFRAME_PREFIX}target-xx`]: { mtimeMs: 0 }
      }
    });
    const result = await sweepOrphanKeyframeDirs({
      tmpDir: '/tmp',
      fsImpl: fakeFs,
      maxAgeMs: 0
    });
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    // The other temp dirs were not stat'd or rm'd.
    expect(fakeFs.stat).toHaveBeenCalledTimes(1);
    expect(fakeFs.rm).toHaveBeenCalledTimes(1);
  });

  test('rm failure is reported but does not throw', async () => {
    const fakeFs = makeFakeFs({
      entries: [{ name: `${KEYFRAME_PREFIX}target-xx`, isDirectory: true }],
      statResults: {
        [`${KEYFRAME_PREFIX}target-xx`]: { mtimeMs: 0 }
      },
      rmImpl: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
    });
    const result = await sweepOrphanKeyframeDirs({
      tmpDir: '/tmp',
      fsImpl: fakeFs,
      maxAgeMs: 0
    });
    expect(result.errors).toBe(1);
    expect(result.removed).toBe(0);
  });

  test('readdir failure produces empty stats (no throw)', async () => {
    const fakeFs = {
      readdir: jest.fn(async () => {
        const err = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      }),
      stat: jest.fn(),
      rm: jest.fn()
    };
    const result = await sweepOrphanKeyframeDirs({ tmpDir: '/tmp', fsImpl: fakeFs });
    expect(result).toEqual({ scanned: 0, removed: 0, skipped: 0, errors: 0 });
    expect(fakeFs.stat).not.toHaveBeenCalled();
    expect(fakeFs.rm).not.toHaveBeenCalled();
  });
});
