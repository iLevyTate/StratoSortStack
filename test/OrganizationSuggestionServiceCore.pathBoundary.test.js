/**
 * Regression tests for isPathWithinFolder — the path-segment boundary check used
 * by cluster-vote folder attribution. A naive startsWith() leaks membership
 * between sibling folders that share a name prefix (e.g. "Art" vs "Articles").
 */

const {
  isPathWithinFolder
} = require('../src/main/services/organization/OrganizationSuggestionServiceCore');

describe('isPathWithinFolder', () => {
  test('matches a file directly inside the folder', () => {
    expect(isPathWithinFolder('/docs/Art/painting.png', '/docs/Art')).toBe(true);
  });

  test('matches nested files inside the folder', () => {
    expect(isPathWithinFolder('/docs/Art/2024/painting.png', '/docs/Art')).toBe(true);
  });

  test('treats the folder path itself as contained', () => {
    expect(isPathWithinFolder('/docs/Art', '/docs/Art')).toBe(true);
  });

  test('does NOT match a sibling folder sharing a name prefix (the bug)', () => {
    expect(isPathWithinFolder('/docs/Articles/post.md', '/docs/Art')).toBe(false);
  });

  test('handles trailing slash on the folder path', () => {
    expect(isPathWithinFolder('/docs/Art/x.png', '/docs/Art/')).toBe(true);
    expect(isPathWithinFolder('/docs/Articles/x.md', '/docs/Art/')).toBe(false);
  });

  test('normalizes backslash separators', () => {
    expect(isPathWithinFolder('C:\\docs\\Art\\x.png', 'C:\\docs\\Art')).toBe(true);
    expect(isPathWithinFolder('C:\\docs\\Articles\\x.md', 'C:\\docs\\Art')).toBe(false);
  });

  test('returns false for empty/invalid inputs', () => {
    expect(isPathWithinFolder('', '/docs/Art')).toBe(false);
    expect(isPathWithinFolder('/docs/Art/x.png', '')).toBe(false);
    expect(isPathWithinFolder(null, undefined)).toBe(false);
  });
});
