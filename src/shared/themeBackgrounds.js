// @ts-check
/**
 * Native BrowserWindow background per app theme (U-002).
 *
 * These MUST equal the `--surface-muted` value of each `data-theme` palette in
 * `src/renderer/styles.css` — the renderer shell background — so the native
 * window color never flashes a different shade before/behind the HTML paints.
 * Guarded against drift by test/shared/themeBackgrounds.test.js.
 */
const THEME_BACKGROUNDS = Object.freeze({
  primary: '#0f1820',
  dark: '#0a0c0e',
  light: '#eef2f6'
});

const DEFAULT_THEME = 'primary';

/** Filename (under userData) where the last applied theme is persisted. */
const THEME_BACKGROUND_FILE = 'theme-background.json';

/**
 * @param {string} theme
 * @returns {boolean}
 */
function isKnownTheme(theme) {
  return Object.prototype.hasOwnProperty.call(THEME_BACKGROUNDS, theme);
}

/**
 * @param {string} [theme]
 * @returns {string}
 */
function resolveThemeBackground(theme) {
  const map = /** @type {Record<string, string>} */ (THEME_BACKGROUNDS);
  return isKnownTheme(theme) ? map[theme] : map[DEFAULT_THEME];
}

module.exports = {
  THEME_BACKGROUNDS,
  THEME_BACKGROUND_FILE,
  DEFAULT_THEME,
  isKnownTheme,
  resolveThemeBackground
};
