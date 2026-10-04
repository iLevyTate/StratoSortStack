/**
 * Drift guard for the native-window theme backgrounds (U-002): the map in
 * src/shared/themeBackgrounds.js MUST equal each theme's `--surface-muted`
 * in src/renderer/styles.css (the renderer shell background), or the native
 * frame flashes a different shade than the HTML that paints over it.
 */
// The suite runs under a memfs mock; the drift check needs the real stylesheet.
const fs = jest.requireActual('fs');
const path = require('path');

const {
  THEME_BACKGROUNDS,
  resolveThemeBackground,
  isKnownTheme
} = require('../../src/shared/themeBackgrounds');

const stylesCss = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8');

/**
 * Extract the FIRST `--surface-muted` value after the given block start.
 * Uses a line-based scan so `--color-surface-muted` never false-matches.
 */
function surfaceMutedAfter(startIndex) {
  const lines = stylesCss.slice(startIndex).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--surface-muted:')) {
      return trimmed.replace('--surface-muted:', '').replace(';', '').trim().toLowerCase();
    }
  }
  return null;
}

describe('themeBackgrounds', () => {
  test.each([
    ['primary', ':root {'],
    ['dark', ":root[data-theme='dark']"],
    ['light', ":root[data-theme='light']"]
  ])('%s matches --surface-muted in styles.css', (theme, blockStart) => {
    const blockIndex = stylesCss.indexOf(blockStart);
    expect(blockIndex).toBeGreaterThan(-1);
    expect(surfaceMutedAfter(blockIndex)).toBe(THEME_BACKGROUNDS[theme]);
  });

  test('unknown or missing themes resolve to the primary background', () => {
    expect(resolveThemeBackground()).toBe(THEME_BACKGROUNDS.primary);
    expect(resolveThemeBackground('solarized')).toBe(THEME_BACKGROUNDS.primary);
    expect(resolveThemeBackground('__proto__')).toBe(THEME_BACKGROUNDS.primary);
    expect(isKnownTheme('dark')).toBe(true);
    expect(isKnownTheme('constructor')).toBe(false);
  });
});
