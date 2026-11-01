/**
 * electron-builder `afterSign` hook: notarizes and staples the signed macOS
 * app, retrying failed attempts.
 *
 * With APPLE_* credentials set, electron-builder notarizes the .app itself
 * right after codesigning, in one attempt. A dropped connection to Apple's
 * notary service then fails the whole build: the macOS x64 release jobs for
 * 5.1.0 (NSURLErrorDomain -1005 while stapling) and 5.1.1 (-1009 while waiting
 * on the submission) both died that way. electron-builder.json sets
 * `mac.notarize` to false and names this hook, which makes the same
 * @electron/notarize call with the same credentials at the same point (after
 * codesigning, before the dmg and zip are built) and retries it.
 */

const path = require('path');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30000;

/**
 * Same credential sources, precedence and errors as electron-builder's
 * MacTargetHelper.getNotarizeOptions. Returns undefined without credentials.
 */
function getNotarizeOptions(appPath, env = process.env) {
  const tool = 'notarytool';
  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;
  if (appleId || appleIdPassword) {
    if (!appleId) throw new Error('APPLE_ID env var needs to be set');
    if (!appleIdPassword) throw new Error('APPLE_APP_SPECIFIC_PASSWORD env var needs to be set');
    if (!teamId) throw new Error('APPLE_TEAM_ID env var needs to be set');
    return { tool, appPath, appleId, appleIdPassword, teamId };
  }
  const appleApiKey = env.APPLE_API_KEY;
  const appleApiKeyId = env.APPLE_API_KEY_ID;
  const appleApiIssuer = env.APPLE_API_ISSUER;
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
      throw new Error(
        'Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set'
      );
    }
    return { tool, appPath, appleApiKey, appleApiKeyId, appleApiIssuer };
  }
  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE;
  if (keychainProfile) {
    const keychain = env.APPLE_KEYCHAIN;
    return { tool, appPath, keychainProfile, ...(keychain ? { keychain } : {}) };
  }
  return undefined;
}

/**
 * The @electron/notarize electron-builder itself loads (app-builder-lib's own
 * copy). The project's top-level @electron/notarize is ESM-only and needs
 * Node 22.12, newer than the Node 20 the release runners use.
 */
function loadNotarize() {
  const appBuilderLib = path.dirname(require.resolve('app-builder-lib/package.json'));
  const notarizeEntry = require.resolve('@electron/notarize', { paths: [appBuilderLib] });
  return require(notarizeEntry).notarize;
}

function firstLine(error) {
  return String((error && error.message) || error).split('\n')[0];
}

/**
 * Calls notarize(options) up to `attempts` times, waiting delayMs, then
 * 2 x delayMs, between attempts. Resubmitting an app notarizes the same
 * signature again; nothing else changes. Returns the attempt that succeeded
 * and rethrows the last error.
 */
async function notarizeWithRetry(
  notarize,
  options,
  {
    attempts = MAX_ATTEMPTS,
    delayMs = RETRY_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console
  } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await notarize(options);
      return attempt;
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = delayMs * attempt;
      log.warn(
        `[notarize] Attempt ${attempt} of ${attempts} failed: ${firstLine(error)}; ` +
          `retrying in ${wait / 1000} s`
      );
      await sleep(wait);
    }
  }
}

async function afterSign(context, { notarize, env = process.env, log = console, ...retry } = {}) {
  // Mac App Store builds ("mas") are not notarized, as in electron-builder.
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const options = getNotarizeOptions(appPath, env);
  if (!options) {
    log.log('[notarize] Skipped: no APPLE_ID, APPLE_API_KEY or APPLE_KEYCHAIN_PROFILE credentials');
    return;
  }
  const attempt = await notarizeWithRetry(notarize || loadNotarize(), options, { log, ...retry });
  log.log(
    `[notarize] ${path.basename(appPath)} notarized and stapled` +
      (attempt > 1 ? ` on attempt ${attempt}` : '')
  );
}

module.exports = { afterSign, getNotarizeOptions, loadNotarize, notarizeWithRetry };
