const { createIpcValidator } = require('../src/preload/ipcValidator');

describe('ipcValidator', () => {
  test('validateEventSource requires sender object', () => {
    const { validateEventSource } = createIpcValidator();
    expect(validateEventSource(null)).toBe(false);
    expect(validateEventSource({})).toBe(false);
    expect(validateEventSource({ sender: {} })).toBe(true);
  });

  test('validateResult handles system metrics', () => {
    const { validateResult } = createIpcValidator();
    const result = validateResult({ uptime: 10 }, 'system:get-metrics');
    expect(result).toEqual({ uptime: 10 });
    expect(validateResult(null, 'system:get-metrics')).toBeNull();
  });

  test('validateResult handles select-directory fallback', () => {
    const { validateResult } = createIpcValidator();
    const result = validateResult(null, 'files:select-directory');
    expect(result).toEqual({ success: false, path: null });
  });

  test('rejects oversized payloads for generic channels', () => {
    const { validateResult } = createIpcValidator();
    const huge = { value: 'x'.repeat(500001) };
    expect(validateResult(huge, 'llama:get-models')).toEqual(
      expect.objectContaining({
        success: false
      })
    );
  });

  test('applies safe fallback for oversized select-directory payload', () => {
    const { validateResult } = createIpcValidator();
    const huge = { value: 'x'.repeat(500001) };
    expect(validateResult(huge, 'files:select-directory')).toEqual({ success: false, path: null });
  });

  test('applies undo-redo specific fallback for oversized payloads', () => {
    const { validateResult } = createIpcValidator();
    const huge = { value: 'x'.repeat(500001) };

    expect(validateResult(huge, 'undo-redo:get-history')).toEqual([]);
    expect(validateResult(huge, 'undo-redo:get-state')).toEqual({
      stack: [],
      pointer: -1,
      canUndo: false,
      canRedo: false
    });
    expect(validateResult(huge, 'undo-redo:undo')).toEqual({
      success: false,
      message: 'Undo/redo response rejected: payload exceeded safety limits'
    });
  });

  test('accepts handler-bounded arrays up to 50000 items (SW-46)', () => {
    const { validateResult } = createIpcValidator();
    const items = Array.from({ length: 50000 }, (_, i) => i);
    expect(validateResult({ items }, 'analysis-history:export')).toEqual({ items });
  });

  test('rejects arrays above the 50000 item handler bound', () => {
    const { validateResult } = createIpcValidator();
    const items = Array.from({ length: 50001 }, (_, i) => i);
    expect(validateResult({ items }, 'llama:get-models')).toEqual(
      expect.objectContaining({ success: false })
    );
  });
});
