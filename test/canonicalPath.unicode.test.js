/**
 * Main composes every path it is given (NFC) and returns the composed form in
 * its result rows. A Mac app can save "März.pdf" decomposed, so the renderer's
 * path keys must compose too, or the moved file is not found in the queue.
 */

import { toCanonicalPath } from '../src/renderer/utils/canonicalPath';

describe('toCanonicalPath and Unicode', () => {
  test('a decomposed POSIX name has the same key as the composed one', () => {
    const composed = '/Users/h/M\u00e4rz.pdf';
    const decomposed = '/Users/h/Ma\u0308rz.pdf';
    expect(decomposed).not.toBe(composed);
    expect(toCanonicalPath(decomposed)).toBe(toCanonicalPath(composed));
    expect(toCanonicalPath(decomposed)).toBe(composed);
  });

  test('a decomposed Windows name matches too, still case-folded', () => {
    expect(toCanonicalPath('C:\\Vertra\u0308ge\\A.pdf')).toBe('c:/vertr\u00e4ge/a.pdf');
  });

  test('POSIX paths keep their case', () => {
    expect(toCanonicalPath('/Users/h/Report.pdf')).toBe('/Users/h/Report.pdf');
  });
});
