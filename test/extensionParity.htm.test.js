/**
 * K-14: `.htm` is the same format as `.html` and documentAnalysis already
 * extracts both, but no supported-extension list named `.htm`, so Discover
 * dropped it while the extractor branch for it was unreachable.
 */
const constants = require('../src/shared/constants');

describe('.htm is accepted wherever .html is', () => {
  test.each([
    'SUPPORTED_DOCUMENT_EXTENSIONS',
    'SUPPORTED_TEXT_EXTENSIONS',
    'ANALYSIS_SUPPORTED_EXTENSIONS',
    'ALL_SUPPORTED_EXTENSIONS'
  ])('%s', (name) => {
    const list = constants[name];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContain('.html');
    expect(list).toContain('.htm');
  });
});
