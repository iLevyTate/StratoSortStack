/**
 * The preload payload-size guard must cover every string that can reach
 * main. The sanitizer collapses objects/arrays past its depth limit to {} /
 * [] but passes a string at that level through unchanged, so the guard must
 * still size-check strings where it stops descending.
 *
 * Loads the real preload with the real sanitizer; only electron is mocked.
 */

const mockInvoke = jest.fn();
const mockExposeInMainWorld = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: jest.fn(),
    removeListener: jest.fn(),
    send: jest.fn()
  },
  webUtils: { getPathForFile: jest.fn() }
}));

const OVER_LIMIT = 5 * 1024 * 1024 + 1;

/** @param {any} leaf @param {number} levels */
function nest(leaf, levels) {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = { k: value };
  return value;
}

/** @param {any} value */
function longestString(value) {
  let max = 0;
  const walk = (/** @type {any} */ v) => {
    if (typeof v === 'string') max = Math.max(max, v.length);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return max;
}

describe('preload IPC payload size guard', () => {
  /** @type {any} */
  let api;

  beforeAll(() => {
    jest.isolateModules(() => {
      require('../src/preload/preload');
    });
    const call = mockExposeInMainWorld.mock.calls.find((c) => c[0] === 'electronAPI');
    api = call[1];
  });

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ success: true });
  });

  test('rejects an oversized string at the top level', async () => {
    await expect(api.smartFolders.save({ k: 'A'.repeat(OVER_LIMIT) })).rejects.toThrow(/too large/);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'smart-folders:save')).toHaveLength(0);
  });

  test.each([31, 32, 33, 34, 40])(
    'never forwards a string over 5MB nested %i levels deep',
    async (levels) => {
      const payload = nest('A'.repeat(OVER_LIMIT), levels);
      let rejected = false;
      try {
        await api.smartFolders.save(payload);
      } catch (error) {
        rejected = /too large/.test(String(/** @type {any} */ (error)?.message));
      }
      const sent = mockInvoke.mock.calls.filter((c) => c[0] === 'smart-folders:save');
      if (!rejected) {
        expect(sent.length).toBeGreaterThan(0);
        for (const c of sent) {
          expect(longestString(c[1])).toBeLessThanOrEqual(5 * 1024 * 1024);
        }
      } else {
        expect(sent).toHaveLength(0);
      }
    }
  );

  test('a deeply nested small payload is still accepted', async () => {
    await api.smartFolders.save(nest('small', 40));
    expect(mockInvoke.mock.calls.some((c) => c[0] === 'smart-folders:save')).toBe(true);
  });
});
