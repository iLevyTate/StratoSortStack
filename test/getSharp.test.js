/**
 * @jest-environment node
 */

describe('createSharpLoader', () => {
  /**
   * Load a fresh copy of getSharp.js with `sharp` stubbed to throw, so the
   * failure path is exercised regardless of whether sharp is installed.
   */
  const loadWithBrokenSharp = () => {
    let createSharpLoader;
    let requireCount = 0;
    jest.isolateModules(() => {
      jest.doMock('sharp', () => {
        requireCount += 1;
        throw Object.assign(new Error('Could not load the "sharp" module'), {
          code: 'ERR_DLOPEN_FAILED'
        });
      });
      ({ createSharpLoader } = require('../src/shared/getSharp'));
    });
    return { createSharpLoader, getRequireCount: () => requireCount };
  };

  test('returns null, records the error, and warns once with the full label', () => {
    const { createSharpLoader, getRequireCount } = loadWithBrokenSharp();
    const warn = jest.fn();
    const label = '[OCR] sharp unavailable, image preprocessing disabled';
    const getSharp = createSharpLoader({ logger: { warn }, label });

    expect(getSharp()).toBeNull();
    expect(getSharp.getLoadError()).toBeInstanceOf(Error);
    expect(getSharp.getLoadError().message).toBe('Could not load the "sharp" module');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(label, {
      error: 'Could not load the "sharp" module',
      code: 'ERR_DLOPEN_FAILED'
    });
    expect(getRequireCount()).toBe(1);
  });

  test('caches the failed attempt: a second call neither re-requires nor re-warns', () => {
    const { createSharpLoader, getRequireCount } = loadWithBrokenSharp();
    const warn = jest.fn();
    const getSharp = createSharpLoader({ logger: { warn } });

    expect(getSharp()).toBeNull();
    expect(getSharp()).toBeNull();
    expect(getRequireCount()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('reset() clears the cached failure so the next call retries the load', () => {
    const { createSharpLoader, getRequireCount } = loadWithBrokenSharp();
    const getSharp = createSharpLoader({});

    expect(getSharp()).toBeNull();
    getSharp.reset();
    expect(getSharp.getLoadError()).toBeNull();

    expect(getSharp()).toBeNull();
    expect(getRequireCount()).toBe(2);
    expect(getSharp.getLoadError()).toBeInstanceOf(Error);
  });

  test('each loader keeps its own cache', () => {
    const { createSharpLoader, getRequireCount } = loadWithBrokenSharp();
    const a = createSharpLoader({ label: 'a' });
    const b = createSharpLoader({ label: 'b' });

    expect(a()).toBeNull();
    expect(b()).toBeNull();
    expect(getRequireCount()).toBe(2);
  });
});
