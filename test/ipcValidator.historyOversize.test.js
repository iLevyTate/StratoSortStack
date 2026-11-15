/**
 * @jest-environment node
 */
const { createIpcValidator } = require('../src/preload/ipcValidator');

// A history page whose entries carry long transcripts can pass the node cap.
// It used to come back as [], which pagination reads as the end of history,
// so Analysis History showed nothing.
describe('ipcValidator - oversized analysis-history:get page', () => {
  test('returns a reason the caller can tell apart from an empty page', () => {
    const warn = jest.fn();
    const { validateResult } = createIpcValidator({ log: { warn } });
    const segments = Array.from({ length: 1000 }, (_, i) => ({ start: i, end: i + 1, text: 'x' }));
    const page = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      analysis: i < 100 ? { transcriptSegments: segments.map((s) => ({ ...s })) } : {}
    }));

    const result = validateResult(page, 'analysis-history:get');

    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({
      success: false,
      error: expect.any(String),
      reason: 'payload-too-large'
    });
  });

  test('passes a page under the cap through unchanged', () => {
    const { validateResult } = createIpcValidator();
    const page = [{ id: '1', analysis: {} }];
    expect(validateResult(page, 'analysis-history:get')).toBe(page);
  });
});
