// @ts-check
/**
 * Single source of truth for the renderer's security response headers.
 *
 * Consumed in two places:
 *   1. createWindow.js `session.webRequest.onHeadersReceived` — applies to dev
 *      loads served over http://127.0.0.1 / http://localhost (and file://).
 *   2. appProtocol.js `protocol.handle('app', …)` — the production load path.
 *      Custom standard schemes do not reliably pass through webRequest, so the
 *      handler sets these headers directly on the Response to guarantee CSP is
 *      enforced in packaged builds.
 *
 * Keeping the policy here prevents the two paths from drifting apart.
 */

const { isDevelopment } = require('../../shared/configDefaults');

// One inline script in src/renderer/index.html sets __STRATOSORT_SPLASH_AT
// before the bundle loads; it is allowed by hash so script-src can stay strict
// (no 'unsafe-inline'/'unsafe-eval'). Production dist/index.html and the
// dev-server HTML can differ (HtmlWebpackPlugin / HMR), so both hashes are
// allowed. IMPORTANT: each hash is sha256 base64 of the UTF-8 bytes inside the
// inline <script>…</script> in the built HTML; recompute on any template change.
const INLINE_SPLASH_SCRIPT_HASHES = Object.freeze([
  // Production (HtmlWebpackPlugin-minified dist/index.html)
  "'sha256-+rAcKTFk7yxyXshhFwEbH9Aio5XWbr7YGo7QkmlIN2c='",
  // Development (unminified build:dev / dev-server HTML)
  "'sha256-f39/1P0IOttywTRLCxSHC0AehneXp8G37TSqcighIHg='"
]);

// The one inline <style> in index.html (splash/theme-scoped pre-paint CSS) is
// allowed by hash so style-src-elem needs no 'unsafe-inline' in production.
// Same recompute rule as the script hashes: sha256 base64 of the UTF-8 bytes
// inside <style>…</style> in the BUILT dist/index.html, prod + dev variants.
// verify:splash-csp checks both.
const INLINE_SPLASH_STYLE_HASHES = Object.freeze([
  // Production (HtmlWebpackPlugin-minified dist/index.html)
  "'sha256-8+FCCPZ8ezpbB/cKbXscRt7pIAxrfFvWCZO/Kgn9c0A='",
  // Development (unminified build:dev / dev-server HTML)
  "'sha256-RGYVlYi/IeA1SUM7P/hf0er+6yKs7/mLILAfHtUsTjQ='"
]);

/**
 * Build the Content-Security-Policy string.
 * @param {{ isDev?: boolean }} [options]
 * @returns {string}
 */
function buildContentSecurityPolicy({ isDev = isDevelopment() } = {}) {
  // style-src hardening (S-1). CSP nuance: CSSOM writes (element.style.x = …,
  // what React/Framer Motion actually do) are NOT governed by CSP at all —
  // the old blanket 'unsafe-inline' premise was wrong. What style-src really
  // gates here:
  //   - <style> ELEMENTS: only the hashed splash <style> in prod ('self'
  //     covers the extracted styles.css); dev needs 'unsafe-inline' because
  //     webpack style-loader injects <style> tags.
  //   - style="" ATTRIBUTES (parser/setAttribute): keep 'unsafe-inline' —
  //     attributes cannot be nonced/hashed practically, and attribute styles
  //     carry no selector-based exfiltration primitives (far weaker surface
  //     than injected <style> elements, which are now blocked in prod).
  // The dev list must NOT include the hashes: per CSP3, the presence of any
  // hash/nonce in a directive makes 'unsafe-inline' ignored, which blocked
  // every style-loader <style> tag and shipped a fully unstyled dev app.
  // 'unsafe-inline' alone also covers the splash <style>, so dev needs no
  // hashes at all.
  // No base style-src fallback: Electron 41's Chromium fully honors
  // style-src-elem/-attr, and the fallback would be default-src 'self'
  // (stricter), never weaker.
  const styleSrcElem = isDev
    ? "'self' 'unsafe-inline'"
    : `'self' ${INLINE_SPLASH_STYLE_HASHES.join(' ')}`;
  const styleSrcAttr = "'unsafe-inline'";
  // Keep script-src strict — no unsafe-eval even in dev (webpack uses a
  // source-map devtool that does not require eval).
  const scriptSrc = `'self' ${INLINE_SPLASH_SCRIPT_HASHES.join(' ')}`;
  // Dev: webpack may fetch async chunks over http(s); local renderer uses random
  // 127.0.0.1 ports. HMR uses ws://localhost when USE_DEV_SERVER=true. Production
  // (app:// and file://) stays locked down to 'self'.
  const connectSrc = isDev
    ? "'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*"
    : "'self'";
  return `default-src 'self'; script-src ${scriptSrc}; style-src-elem ${styleSrcElem}; style-src-attr ${styleSrcAttr}; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connectSrc}; object-src 'none'; base-uri 'self'; form-action 'self';`;
}

// Disable sensitive features by default, but allow clipboard for the copy-path
// functionality the renderer relies on.
const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), clipboard-read=(self), clipboard-write=(self), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()';

/**
 * Non-CSP security headers as single string values. The webRequest API wants
 * arrays (see toWebRequestHeaderArrays); the Fetch Headers API wants strings.
 */
const STATIC_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', // Prevent clickjacking
  // Legacy header: ignored by Chrome 78+ but Mozilla Observatory and other
  // security scanners still reward its presence; defense-in-depth, low cost.
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'no-referrer',
  // COOP/COEP can break some integrations; set COOP/CORP only.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY
});

/**
 * Express STATIC_SECURITY_HEADERS in the array-of-strings shape that
 * webRequest.onHeadersReceived expects.
 * @returns {Record<string, string[]>}
 */
function toWebRequestHeaderArrays() {
  return Object.fromEntries(
    Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => [key, [value]])
  );
}

module.exports = {
  buildContentSecurityPolicy,
  STATIC_SECURITY_HEADERS,
  toWebRequestHeaderArrays
};
