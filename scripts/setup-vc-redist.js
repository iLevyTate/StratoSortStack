#!/usr/bin/env node
// @ts-check
/**
 * Microsoft Visual C++ Redistributable staging (Windows builds only)
 *
 * Downloads Microsoft's official, unmodified `vc_redist.<arch>.exe` into
 * assets/runtime/vcredist/ so the Windows installer (build/installer-themed.nsh)
 * and the in-app "Install now" action (src/main/utils/vcRuntimeInstaller.js)
 * can install the VC++ 2015-2022 (v14) runtime that node-llama-cpp's Windows
 * binaries import (MSVCP140.dll, VCRUNTIME140.dll). electron-builder ships the
 * file only in Windows packages (`win.extraResources` in electron-builder.json).
 *
 * Source: Microsoft's permanent "latest supported v14" links
 *   https://aka.ms/vc14/vc_redist.x64.exe
 *   https://aka.ms/vc14/vc_redist.arm64.exe
 * which redirect to download.visualstudio.microsoft.com. Every hop must be
 * HTTPS on a Microsoft host (aka.ms, microsoft.com and its subdomains).
 *
 * Verification (fail closed): after download the file must carry a Valid
 * Authenticode signature from O=Microsoft Corporation (PowerShell
 * Get-AuthenticodeSignature, see src/main/utils/authenticode.js). Anything
 * else deletes the file and exits non-zero. Authenticode can only be checked
 * on Windows, so a non-Windows host fails unless
 * STRATOSORT_VC_REDIST_SKIP_VERIFY=1 is set (the manifest then records
 * `verified: false`). The product version, sha256 and signer go into
 * vc_redist.<arch>.json next to the exe.
 *
 * Licensing: the redistributable is Microsoft "Distributable Code" under the
 * Visual Studio license terms. Personal/noncommercial builds may ship it;
 * business/commercial-licensed builds must confirm a Visual Studio license
 * that covers redistribution before shipping (docs/COMMERCIAL_COMPLIANCE.md).
 *
 * Usage:
 *   node scripts/setup-vc-redist.js [--arch=x64|arm64]           # download if missing
 *   node scripts/setup-vc-redist.js --check [--arch=x64|arm64]   # presence + signature + manifest
 *   node scripts/setup-vc-redist.js --refresh [--arch=...]       # re-download even if verified
 *   node scripts/setup-vc-redist.js --windows-host-only          # no-op off Windows (npm run dist)
 *
 * Environment:
 *   STRATOSORT_VC_REDIST_SKIP_VERIFY=1   allow a non-Windows host to stage (and --check) the
 *                                        file without Authenticode verification
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const authenticode = require('../src/main/utils/authenticode');

const SUPPORTED_ARCHES = Object.freeze(['x64', 'arm64']);
const DOWNLOAD_URLS = Object.freeze({
  x64: 'https://aka.ms/vc14/vc_redist.x64.exe',
  arm64: 'https://aka.ms/vc14/vc_redist.arm64.exe'
});
// x64 is ~18 MB and arm64 ~12 MB (14.51, 2026-11). Anything far outside is an
// error page or a truncated/unexpected file.
const MIN_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SKIP_VERIFY_ENV = 'STRATOSORT_VC_REDIST_SKIP_VERIFY';
const REDIST_DIR = path.join(__dirname, '..', 'assets', 'runtime', 'vcredist');
const LOG_PREFIX = '[vc-redist]';

/** @param {string} arch */
function redistFileName(arch) {
  return `vc_redist.${arch}.exe`;
}

/** @param {string} arch */
function manifestFileName(arch) {
  return `vc_redist.${arch}.json`;
}

/**
 * Microsoft hosts only: aka.ms (the permanent link) and microsoft.com or any
 * of its subdomains (download.visualstudio.microsoft.com serves the file).
 * @param {unknown} hostname
 */
function isAllowedHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase();
  return host === 'aka.ms' || host === 'microsoft.com' || host.endsWith('.microsoft.com');
}

/** @param {string} rawUrl */
function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid download URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error(`Refusing non-HTTPS URL: ${rawUrl}`);
  if (url.username || url.password) throw new Error(`Refusing credentialed URL: ${rawUrl}`);
  if (!isAllowedHost(url.hostname)) {
    throw new Error(`Refusing download from non-Microsoft host: ${url.hostname}`);
  }
  return url;
}

/** @param {string} [hostArch] */
function defaultArch(hostArch = process.arch) {
  return hostArch === 'arm64' ? 'arm64' : 'x64';
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = {
    arch: defaultArch(),
    check: false,
    refresh: false,
    help: false,
    windowsHostOnly: false
  };
  for (const raw of argv) {
    if (raw === '--check') args.check = true;
    else if (raw === '--refresh' || raw === '--force') args.refresh = true;
    else if (raw === '--windows-host-only') args.windowsHostOnly = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--arch=')) args.arch = raw.slice('--arch='.length).trim();
  }
  return args;
}

/** @param {string} filePath @returns {Promise<string>} */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Stream an HTTPS download to `<dest>.partial`, following redirects only to
 * Microsoft hosts and enforcing the size bounds while streaming.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<{ partialPath: string, finalUrl: string, size: number }>}
 */
function downloadToFile(url, destPath) {
  const partialPath = `${destPath}.partial`;
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {Error} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      fsp
        .unlink(partialPath)
        .catch(() => {})
        .finally(() => reject(err));
    };

    /** @param {string} target @param {number} redirectsLeft */
    const follow = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = validateUrl(target);
      } catch (error) {
        fail(/** @type {Error} */ (error));
        return;
      }
      const req = https.get(
        parsed.toString(),
        { headers: { 'User-Agent': 'StratoSort-VcRedistSetup/1.0' } },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              fail(new Error('Too many redirects'));
              return;
            }
            follow(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new Error(`HTTP ${status} downloading ${target}`));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_BYTES) {
            res.resume();
            fail(new Error(`Download too large (${declared} bytes > ${MAX_BYTES})`));
            return;
          }
          let size = 0;
          const out = fs.createWriteStream(partialPath);
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
              res.destroy(new Error(`Download exceeded ${MAX_BYTES} bytes`));
            }
          });
          res.on('error', (err) => {
            out.destroy();
            fail(err);
          });
          out.on('error', fail);
          out.on('finish', () => {
            if (settled) return;
            if (size < MIN_BYTES) {
              fail(
                new Error(
                  `Download too small (${size} bytes < ${MIN_BYTES}); not a redistributable`
                )
              );
              return;
            }
            settled = true;
            resolve({ partialPath, finalUrl: parsed.toString(), size });
          });
          res.pipe(out);
        }
      );
      req.setTimeout(120000, () => req.destroy(new Error('Download timeout')));
      req.on('error', fail);
    };

    follow(url, MAX_REDIRECTS);
  });
}

/**
 * Non-Windows hosts only: stage/check without Authenticode.
 * @param {NodeJS.ProcessEnv} env
 */
function skipVerifyRequested(env) {
  return env.STRATOSORT_VC_REDIST_SKIP_VERIFY === '1';
}

/**
 * Check the signature, or explain why it cannot be checked here.
 * @param {string} filePath
 * @param {{ platform: string, env: NodeJS.ProcessEnv }} host
 * @returns {{ verified: boolean, info: import('../src/main/utils/authenticode').AuthenticodeInfo | null }}
 */
function verifySignature(filePath, { platform, env }) {
  if (platform !== 'win32') {
    if (skipVerifyRequested(env)) return { verified: false, info: null };
    throw new Error(
      `Authenticode verification of ${path.basename(filePath)} needs a Windows host ` +
        '(PowerShell Get-AuthenticodeSignature). Build Windows packages on Windows, or set ' +
        `${SKIP_VERIFY_ENV}=1 to stage it unverified.`
    );
  }
  /** @type {{ exitCode?: number | null, stderr?: string, error?: string }} */
  const diagnostics = {};
  const verdict = authenticode.verifyMicrosoftSignatureSync(filePath, { env, diagnostics });
  if (!verdict.ok) {
    const info = verdict.info;
    const why =
      verdict.reason === 'unreadable'
        ? ` PowerShell exit ${diagnostics.exitCode ?? 'n/a'}` +
          (diagnostics.error ? `, error: ${diagnostics.error}` : '') +
          (diagnostics.stderr ? `, stderr: ${diagnostics.stderr}` : '') +
          '.'
        : '';
    throw new Error(
      `${path.basename(filePath)} failed Authenticode verification (${verdict.reason}; ` +
        `status ${info?.status ?? 'unknown'}, signer ${info?.subject ?? 'none'}). ` +
        'Expected a Valid signature from O=Microsoft Corporation.' +
        why
    );
  }
  return { verified: true, info: verdict.info };
}

/** @param {string} manifestPath */
async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Presence + signature + manifest. Returns the manifest when the staged file
 * is usable, throws with the reason otherwise.
 * @param {{ arch: string, dir: string, platform: string, env: NodeJS.ProcessEnv }} options
 */
async function checkStaged({ arch, dir, platform, env }) {
  const exePath = path.join(dir, redistFileName(arch));
  const manifestPath = path.join(dir, manifestFileName(arch));
  if (!fs.existsSync(exePath)) throw new Error(`missing ${exePath}`);
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error(`missing or unreadable manifest ${manifestPath}`);
  if (manifest.arch !== arch || manifest.file !== redistFileName(arch)) {
    throw new Error(`manifest ${manifestPath} is for ${manifest.file} (${manifest.arch})`);
  }
  const sha256 = await sha256File(exePath);
  if (manifest.sha256 !== sha256) {
    throw new Error(`${redistFileName(arch)} does not match the sha256 in ${manifestPath}`);
  }
  // On a non-Windows host with the skip flag this confirms only the hash.
  const { verified } = verifySignature(exePath, { platform, env });
  if (verified && !manifest.productVersion) {
    throw new Error(`manifest ${manifestPath} has no productVersion`);
  }
  return manifest;
}

/**
 * Download (unless a verified copy is already staged), verify, write manifest.
 * @param {{ arch: string, refresh?: boolean, dir?: string, platform?: string, env?: NodeJS.ProcessEnv, log?: (msg: string) => void }} options
 * @returns {Promise<{ status: 'present' | 'downloaded', exePath: string, manifest: any }>}
 */
async function setupVcRedist({
  arch,
  refresh = false,
  dir = REDIST_DIR,
  platform = process.platform,
  env = process.env,
  log = (msg) => console.log(`${LOG_PREFIX} ${msg}`)
}) {
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`Unsupported --arch "${arch}" (expected ${SUPPORTED_ARCHES.join(' or ')})`);
  }
  const exePath = path.join(dir, redistFileName(arch));
  const manifestPath = path.join(dir, manifestFileName(arch));

  // Fail fast, before any download, when this host cannot verify.
  if (platform !== 'win32' && !skipVerifyRequested(env))
    verifySignature(exePath, { platform, env });

  if (!refresh && fs.existsSync(exePath)) {
    try {
      const manifest = await checkStaged({ arch, dir, platform, env });
      log(`already staged and verified: ${exePath} (${manifest.productVersion || 'unverified'})`);
      return { status: 'present', exePath, manifest };
    } catch (error) {
      log(`staged copy rejected (${/** @type {Error} */ (error).message}); downloading again`);
    }
  }

  await fsp.mkdir(dir, { recursive: true });
  await fsp.rm(exePath, { force: true });
  await fsp.rm(manifestPath, { force: true });

  const sourceUrl = DOWNLOAD_URLS[/** @type {'x64' | 'arm64'} */ (arch)];
  log(`downloading ${sourceUrl}`);
  const { partialPath, finalUrl, size } = await downloadToFile(sourceUrl, exePath);

  let verification;
  try {
    verification = verifySignature(partialPath, { platform, env });
  } catch (error) {
    await fsp.rm(partialPath, { force: true });
    throw error;
  }
  await fsp.rename(partialPath, exePath);

  const info = verification.info;
  const manifest = {
    file: redistFileName(arch),
    arch,
    productVersion: info?.productVersion ?? null,
    fileVersion: info?.fileVersion ?? null,
    sha256: await sha256File(exePath),
    size,
    verified: verification.verified,
    signatureStatus: info?.status ?? 'not-checked',
    signer: info?.subject ?? null,
    sourceUrl,
    resolvedUrl: finalUrl,
    stagedAt: new Date().toISOString()
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!verification.verified) {
    log(`WARNING: staged WITHOUT Authenticode verification (${SKIP_VERIFY_ENV}=1)`);
  }
  log(
    `staged ${exePath} (${manifest.productVersion || 'version unknown'}, ` +
      `${(size / 1024 / 1024).toFixed(1)} MB)`
  );
  return { status: 'downloaded', exePath, manifest };
}

function printHelp() {
  console.log(`Usage: node scripts/setup-vc-redist.js [options]

Options:
  --arch=<x64|arm64>  Redistributable to stage (default: host arch, x64 unless arm64)
  --check             Verify presence, Authenticode signature and manifest; exit non-zero if not
  --refresh           Re-download even if a verified copy is already staged
  --windows-host-only Do nothing unless this host is Windows (host-platform builds: dist, package)
  -h, --help          Print this help

Env: ${SKIP_VERIFY_ENV}=1 (non-Windows hosts only: stage/check without Authenticode)`);
}

/**
 * @param {string[]} argv
 * @param {{ dir?: string, platform?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>} process exit code
 */
async function main(
  argv,
  { dir = REDIST_DIR, platform = process.platform, env = process.env } = {}
) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!SUPPORTED_ARCHES.includes(args.arch)) {
    console.error(`${LOG_PREFIX} unsupported --arch "${args.arch}" (expected x64 or arm64)`);
    return 1;
  }
  if (args.windowsHostOnly && platform !== 'win32') {
    // `npm run dist` / `package` build the host's own platform; only a
    // Windows host produces a Windows package that needs the redistributable.
    console.log(`${LOG_PREFIX} not a Windows host; nothing to stage for this build.`);
    return 0;
  }
  try {
    if (args.check) {
      const manifest = await checkStaged({ arch: args.arch, dir, platform, env });
      console.log(
        `${LOG_PREFIX} OK: ${redistFileName(args.arch)} ${manifest.productVersion || ''} ` +
          `(${manifest.verified ? 'Microsoft-signed' : 'unverified'})`
      );
      return 0;
    }
    await setupVcRedist({ arch: args.arch, refresh: args.refresh, dir, platform, env });
    return 0;
  } catch (error) {
    console.error(
      `${LOG_PREFIX} ${args.check ? 'check' : 'setup'} failed: ${/** @type {Error} */ (error).message}`
    );
    return args.check ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  DOWNLOAD_URLS,
  MAX_BYTES,
  MIN_BYTES,
  REDIST_DIR,
  SKIP_VERIFY_ENV,
  SUPPORTED_ARCHES,
  checkStaged,
  defaultArch,
  isAllowedHost,
  main,
  manifestFileName,
  parseArgs,
  redistFileName,
  setupVcRedist,
  validateUrl
};
