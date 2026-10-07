// @ts-check
/**
 * In-app support contact and runtime diagnostics helpers for the About screen.
 */

/**
 * @typedef {{
 *   appName?: string,
 *   appVersion?: string,
 *   platform?: string,
 *   arch?: string,
 *   osRelease?: string,
 *   electronVersion?: string,
 *   chromeVersion?: string,
 *   nodeVersion?: string,
 *   isPackaged?: boolean,
 *   buildSha?: string,
 *   mediaStack?: any
 * }} RuntimeInfo
 */

const SUPPORT_EMAIL = 'contact@kennedyappliedsciences.com';
// Commercial licensing is email-only (docs/COMMERCIAL.md); same mailbox today.
const SALES_EMAIL = 'contact@kennedyappliedsciences.com';

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @param {string} [osRelease]
 * @returns {string}
 */
function formatPlatform(platform, arch, osRelease) {
  const platformLabel =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform || 'Unknown';
  const release = osRelease ? ` ${osRelease}` : '';
  return `${platformLabel} (${arch})${release}`;
}

/**
 * @param {any} [mediaStack]
 * @returns {string}
 */
function describeWhisperStack(mediaStack) {
  const whisper = mediaStack?.whisper;
  if (!whisper) {
    const reason = mediaStack?.reason;
    if (reason === 'whisper-service-not-registered') return 'Not initialized yet';
    return 'Unavailable';
  }
  if (!whisper.loaded) {
    if (whisper.modelPresent === false) {
      return 'Not installed';
    }
    const model = whisper.modelFilename ? ` · ${whisper.modelFilename}` : '';
    return `Ready${model}`;
  }
  const variant = whisper.resolvedVariant || 'default';
  const backend = whisper.backend || 'cpu';
  const model = whisper.modelFilename ? ` · ${whisper.modelFilename}` : '';
  return `${variant} on ${backend}${model}`;
}

/**
 * @param {RuntimeInfo} [info]
 * @returns {string}
 */
function buildSupportReportBody(info = {}) {
  return [
    'Please describe what happened and how to reproduce it.',
    '',
    '## What happened',
    '',
    '## Steps to reproduce',
    '',
    '1.',
    '2.',
    '3.',
    '',
    '## Expected vs actual',
    '',
    '## Runtime',
    '',
    `- App: ${info?.appName || 'StratoSort Stack'} ${info?.appVersion || ''}`.trim(),
    `- Platform: ${formatPlatform(info?.platform, info?.arch, info?.osRelease)}`,
    `- Electron: ${info?.electronVersion || 'unknown'}`,
    `- Chrome: ${info?.chromeVersion || 'unknown'}`,
    `- Node: ${info?.nodeVersion || 'unknown'}`,
    `- Build: ${info?.isPackaged ? 'packaged' : 'dev'}${info?.buildSha ? ` (${info.buildSha})` : ''}`,
    `- Whisper: ${describeWhisperStack(info?.mediaStack)}`,
    '',
    '## Logs',
    '',
    'Attach the most recent log from Settings → About → Open logs folder (or use Settings → Diagnostics → Export logs for a redacted archive).'
  ].join('\n');
}

/**
 * @param {RuntimeInfo} [info]
 * @returns {string}
 */
function buildVersionString(info) {
  if (!info) return '';
  return [
    `${info.appName || 'StratoSort Stack'} ${info.appVersion || ''}`.trim(),
    `Platform: ${formatPlatform(info.platform, info.arch, info.osRelease)}`,
    `Electron ${info.electronVersion || '?'} · Chrome ${info.chromeVersion || '?'} · Node ${info.nodeVersion || '?'}`,
    info.isPackaged ? 'Build: packaged' : 'Build: dev',
    info.buildSha ? `SHA: ${info.buildSha}` : null,
    `Whisper: ${describeWhisperStack(info.mediaStack)}`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {RuntimeInfo} [info]
 * @returns {string}
 */
function buildSupportMailtoUrl(info = {}) {
  const versionLabel = info?.appVersion ? `v${info.appVersion}` : 'unknown version';
  const subject = encodeURIComponent(`StratoSort Stack support — ${versionLabel}`);
  const body = encodeURIComponent(buildSupportReportBody(info));
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/**
 * Pre-filled purchase inquiry mirroring the checklist in docs/COMMERCIAL.md.
 * @param {RuntimeInfo} [info]
 * @returns {string}
 */
function buildCommercialInquiryMailtoUrl(info = {}) {
  const versionLabel = info?.appVersion ? ` v${info.appVersion}` : '';
  const subject = encodeURIComponent(`StratoSort Stack commercial license inquiry${versionLabel}`);
  const body = encodeURIComponent(
    [
      'Please send a quote for a commercial license.',
      '',
      '- Organization name:',
      '- Number of seats:',
      '- License for: packaged app / source / both',
      ''
    ].join('\n')
  );
  return `mailto:${SALES_EMAIL}?subject=${subject}&body=${body}`;
}

module.exports = {
  SUPPORT_EMAIL,
  SALES_EMAIL,
  buildCommercialInquiryMailtoUrl,
  formatPlatform,
  describeWhisperStack,
  buildSupportReportBody,
  buildVersionString,
  buildSupportMailtoUrl
};
