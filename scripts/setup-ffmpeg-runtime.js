#!/usr/bin/env node
/**
 * FFmpeg Runtime Setup Script
 *
 * Downloads a platform-specific LGPL-licensed FFmpeg binary and places it in
 * assets/runtime/ffmpeg/ for bundling with the production installer. Replaces
 * the prior `ffmpeg-static` npm dependency, which shipped a GPL-3 build whose
 * viral clause is incompatible with closed-source commercial distribution.
 *
 * MediaTranscoder.js resolves the binary via a multi-source lookup:
 *   1. STRATOSORT_FFMPEG_PATH env var (explicit override)
 *   2. assets/runtime/ffmpeg/<binary> (bundled, this script's output)
 *   3. system PATH (defensive fallback)
 *
 * Why LGPL instead of GPL: We only invoke ffmpeg via child_process.spawn() —
 * no FFI linking — so the LGPL "relink-ability" obligation does not apply,
 * and a static LGPL build is the simplest and cleanest bundle. Distribution
 * obligations are limited to including the LGPL-3 license text and a link to
 * upstream sources. See assets/runtime/ffmpeg/NOTICE.md.
 *
 * Sources:
 *   Windows : BtbN/FFmpeg-Builds GitHub releases ("master-latest-win64-lgpl.zip")
 *   macOS   : StratoSort self-hosted GitHub release built by
 *             .github/workflows/build-ffmpeg-lgpl.yml. The workflow compiles
 *             FFmpeg from upstream sources with --disable-gpl --disable-nonfree
 *             for both x64 and arm64, then uploads two zips
 *             (ffmpeg-mac-{x64,arm64}.zip) plus the exact upstream source
 *             tarball (ffmpeg-<version>-source.tar.xz, the LGPL §6 offer)
 *             to a release tagged STRATOSORT_FFMPEG_TAG (default
 *             "ffmpeg-lgpl-latest") on iLevyTate/StratoSortStack. Override the
 *             entire URL via STRATOSORT_FFMPEG_URL when working with a fork.
 *             The two common public mac builders (evermeet.cx and
 *             martin-riedl.de) both ship GPL FFmpeg with x264/x265 — fatal for
 *             closed-source commercial distribution — which is why we build
 *             our own. See assets/runtime/ffmpeg/NOTICE.md for attribution and
 *             source-offer details.
 *   Linux   : BtbN/FFmpeg-Builds GitHub releases
 *             ("master-latest-{linux64,linuxarm64}-lgpl.tar.xz"). BtbN ships
 *             these as .tar.xz, which Node's `tar` lib cannot decompress, so we
 *             shell out to the system `tar -xJf` (GNU tar + liblzma, present on
 *             every Linux runner and macOS). Static LGPL build — single binary,
 *             no shared-lib soup. Both x64 and arm64 are supported.
 *
 * Usage:
 *   node scripts/setup-ffmpeg-runtime.js            # Download for current platform
 *   node scripts/setup-ffmpeg-runtime.js --check    # Check if runtime is present
 *   node scripts/setup-ffmpeg-runtime.js --force    # Re-download even if present
 *
 * Environment:
 *   SKIP_FFMPEG_RUNTIME=true                Skip download (CI / fast dev)
 *   STRATOSORT_FFMPEG_TAG                   BtbN release tag (default: 'latest')
 *   STRATOSORT_FFMPEG_URL                   Override the download URL entirely
 *   STRATOSORT_FFMPEG_RUNTIME_PLATFORM      Override host OS: win32 | darwin | linux
 *                                           (use when packaging cross-platform)
 *   STRATOSORT_FFMPEG_RUNTIME_ARCH          Override process.arch: x64 | arm64
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');

// Windows/Linux default to BtbN's floating `latest` release. Dated
// `autobuild-*` tags are deleted after a few weeks, so a hard-coded one turns
// every later release build into a 404; pin one per build through
// STRATOSORT_FFMPEG_TAG (with STRATOSORT_FFMPEG_URL for its asset name) when a
// reproducible binary matters more than a build that keeps working.
const FFMPEG_RELEASE_TAG = process.env.STRATOSORT_FFMPEG_TAG || 'latest';

// SECURITY: hostname allowlist. The override env var (STRATOSORT_FFMPEG_URL)
// is attacker-influential — silently accepting http:// or an arbitrary host
// would be a supply-chain hole. github.com hosts BtbN; evermeet.cx hosts the
// macOS LGPL builds.
const ALLOWED_RUNTIME_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
  'evermeet.cx'
]);
const MAX_REDIRECTS = 5;

function isAllowedRuntimeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return ALLOWED_RUNTIME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function validateRuntimeUrl(rawUrl, context = 'ffmpeg runtime download') {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${context} URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked non-HTTPS ${context} URL (got ${parsed.protocol}//${parsed.host}): ${rawUrl}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked credentialed ${context} URL`);
  }
  if (!isAllowedRuntimeHost(parsed.hostname)) {
    throw new Error(`Blocked ${context} from untrusted host: ${parsed.hostname}`);
  }
  return parsed;
}

function getTargetPlatform() {
  const p = process.env.STRATOSORT_FFMPEG_RUNTIME_PLATFORM;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  return process.platform;
}

function getTargetArch() {
  const a = process.env.STRATOSORT_FFMPEG_RUNTIME_ARCH;
  if (a === 'x64' || a === 'arm64') return a;
  return process.arch;
}

const TARGET_PLATFORM = getTargetPlatform();
const FFMPEG_BINARY_NAME = TARGET_PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

const RUNTIME_DIR = path.join(__dirname, '..', 'assets', 'runtime', 'ffmpeg');
const MANIFEST_PATH = path.join(RUNTIME_DIR, 'ffmpeg-runtime.json');

function inferArchiveType(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  return null;
}

// --- Asset resolution -------------------------------------------------------

function getAssetConfig() {
  const overrideUrl = process.env.STRATOSORT_FFMPEG_URL;
  if (overrideUrl && overrideUrl.trim()) {
    validateRuntimeUrl(overrideUrl.trim(), 'STRATOSORT_FFMPEG_URL override');
    const archiveType = inferArchiveType(overrideUrl);
    if (!archiveType) {
      throw new Error(
        'Unsupported ffmpeg runtime archive format (must be .zip, .tar.gz, or .tar.xz)'
      );
    }
    return {
      tag: 'custom',
      assetName: path.basename(overrideUrl),
      archiveType,
      url: overrideUrl.trim()
    };
  }

  const platform = TARGET_PLATFORM;
  const arch = getTargetArch();

  if (platform === 'win32') {
    if (arch !== 'x64') {
      throw new Error(`Unsupported Windows architecture for ffmpeg runtime: ${arch}`);
    }
    const tag = FFMPEG_RELEASE_TAG;
    const assetName = 'ffmpeg-master-latest-win64-lgpl.zip';
    return {
      tag,
      assetName,
      archiveType: 'zip',
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${assetName}`
    };
  }

  if (platform === 'darwin') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported macOS architecture for ffmpeg runtime: ${arch}`);
    }
    // Resolution: built LGPL-only by .github/workflows/build-ffmpeg-lgpl.yml,
    // uploaded to a StratoSort GitHub release. Public macOS distributions
    // (evermeet.cx, martin-riedl.de) ship --enable-gpl with x264/x265 —
    // incompatible with closed-source distribution — which is why we build
    // our own. Override the tag via STRATOSORT_FFMPEG_TAG (default
    // 'ffmpeg-lgpl-latest', the floating tag the workflow republishes on
    // each successful build); override the entire URL via
    // STRATOSORT_FFMPEG_URL when working from a fork.
    const macTag =
      FFMPEG_RELEASE_TAG && FFMPEG_RELEASE_TAG !== 'latest'
        ? FFMPEG_RELEASE_TAG
        : 'ffmpeg-lgpl-latest';
    const assetName = `ffmpeg-mac-${arch}.zip`;
    return {
      tag: macTag,
      assetName,
      archiveType: 'zip',
      url: `https://github.com/iLevyTate/StratoSortStack/releases/download/${macTag}/${assetName}`
    };
  }

  if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported Linux architecture for ffmpeg runtime: ${arch}`);
    }
    const archToken = arch === 'arm64' ? 'linuxarm64' : 'linux64';
    const tag = FFMPEG_RELEASE_TAG;
    const assetName = `ffmpeg-master-latest-${archToken}-lgpl.tar.xz`;
    return {
      tag,
      assetName,
      archiveType: 'tar.xz',
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${assetName}`
    };
  }

  throw new Error(`Unsupported platform for ffmpeg runtime: ${platform}`);
}

// --- Download ---------------------------------------------------------------

function buildDownloadHeaders(url) {
  const headers = { 'User-Agent': 'StratoSort' };
  // Private GitHub release assets require auth on the github.com call. The
  // 302 redirect target (objects.githubusercontent.com) is a presigned S3
  // URL — sending the GitHub PAT to S3 would be both unnecessary and
  // potentially rejected, so we only attach auth for github.com hosts.
  // GITHUB_TOKEN is auto-injected by Actions runners; locally, devs must
  // either set their own PAT or rely on SKIP_FFMPEG_RUNTIME=true.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && /^https:\/\/(api\.)?github\.com\//.test(url)) {
    headers.Authorization = `Bearer ${token}`;
    headers.Accept = 'application/octet-stream';
  }
  return headers;
}

function downloadFile(url, destination, redirectsLeft = MAX_REDIRECTS) {
  validateRuntimeUrl(url, 'ffmpeg runtime download');

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: buildDownloadHeaders(url) }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.destroy();
        if (redirectsLeft <= 0) {
          reject(new Error(`Exceeded max redirects (${MAX_REDIRECTS}) downloading ${url}`));
          return;
        }
        let resolvedRedirect;
        try {
          resolvedRedirect = new URL(response.headers.location, url).toString();
        } catch {
          reject(new Error(`Invalid redirect target from ${url}: ${response.headers.location}`));
          return;
        }
        try {
          validateRuntimeUrl(resolvedRedirect, 'ffmpeg runtime redirect');
        } catch (err) {
          reject(err);
          return;
        }
        downloadFile(resolvedRedirect, destination, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      let lastLogTime = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastLogTime > 2000) {
          const pct = totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : '?';
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalMb = totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) : '?';
          process.stdout.write(`\r  Progress: ${mb} MB / ${totalMb} MB (${pct}%)    `);
          lastLogTime = now;
        }
      });

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          process.stdout.write('\n');
          resolve();
        });
      });
      fileStream.on('error', (error) => {
        fsp.unlink(destination).catch(() => {});
        reject(error);
      });
    });

    request.on('error', reject);
    request.setTimeout(300000, () => {
      request.destroy();
      reject(new Error('Download timeout (5 minutes)'));
    });
  });
}

// --- Extraction -------------------------------------------------------------

async function findBinaryInDir(rootDir, binaryName, maxDepth = 5) {
  async function walk(dir, depth) {
    if (depth < 0) return null;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === binaryName) {
        return path.join(dir, entry.name);
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await walk(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(rootDir, maxDepth);
}

function isPathInsideDir(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(rootWithSep);
}

async function extractArchive(archivePath, extractDir, archiveType) {
  const resolvedDir = path.resolve(extractDir);

  if (archiveType === 'zip') {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archivePath);
    // Zip-slip defense: walk every entry and abort before extraction if any
    // entry is absolute or resolves outside the destination.
    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      if (path.isAbsolute(name)) {
        throw new Error(`Archive entry is absolute path (zip-slip): ${name}`);
      }
      const resolved = path.resolve(resolvedDir, name);
      if (!isPathInsideDir(resolvedDir, resolved)) {
        throw new Error(`Archive entry escapes destination (zip-slip): ${name}`);
      }
    }
    zip.extractAllTo(resolvedDir, true);
    return;
  }

  if (archiveType === 'tar.gz') {
    const tar = require('tar');
    await tar.x({
      file: archivePath,
      cwd: resolvedDir,
      filter: (entryPath) => {
        if (path.isAbsolute(entryPath)) {
          throw new Error(`Archive entry is absolute path (tar-slip): ${entryPath}`);
        }
        const resolved = path.resolve(resolvedDir, entryPath);
        if (!isPathInsideDir(resolvedDir, resolved)) {
          throw new Error(`Archive entry escapes destination (tar-slip): ${entryPath}`);
        }
        return true;
      }
    });
    return;
  }

  if (archiveType === 'tar.xz') {
    // Node's `tar` lib has no xz support and a pure-JS xz decoder is slow on
    // the ~100MB BtbN tarballs while a native lzma addon would need its own
    // rebuild (defeating the point). Every Linux runner and macOS ships tar
    // linked against liblzma, so we shell out. Both GNU and BSD tar strip
    // leading slashes by default; the destination is a freshly-created temp
    // dir (see downloadRuntime), and assertNoArchiveEscape below post-validates
    // that nothing — including symlinks and `..` members — resolves outside
    // resolvedDir, preserving the tar-slip posture. (We avoid
    // `--no-absolute-names`, which is a BSD-tar-only flag GNU tar rejects.)
    const { spawnSync } = require('child_process');
    const result = spawnSync('tar', ['-xJf', archivePath, '-C', resolvedDir], {
      stdio: 'inherit'
    });
    if (result.error) {
      throw new Error(
        `Failed to spawn system tar for .tar.xz extraction: ${result.error.message}. ` +
          'Install GNU tar with xz support (e.g. `apt-get install xz-utils`) or set ' +
          'STRATOSORT_FFMPEG_URL to a .zip/.tar.gz asset.'
      );
    }
    if (result.status !== 0) {
      throw new Error(`system tar exited with status ${result.status} extracting ${archivePath}`);
    }
    await assertNoArchiveEscape(resolvedDir);
    return;
  }

  throw new Error(`Unsupported archive type: ${archiveType}`);
}

// Post-extraction tar-slip guard for archives unpacked by external `tar`
// (the system tar branch above). Walks the extracted tree and rejects any
// entry — including symlinks — whose real path resolves outside `root`.
async function assertNoArchiveEscape(root) {
  const resolvedRoot = path.resolve(root);
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // realpath collapses symlinks; a malicious link pointing outside the
      // destination is caught here.
      let real;
      try {
        real = await fsp.realpath(abs);
      } catch {
        // Dangling symlink: resolve its declared target relative to its dir.
        real = path.resolve(dir, await fsp.readlink(abs).catch(() => entry.name));
      }
      if (!isPathInsideDir(resolvedRoot, real)) {
        throw new Error(`Archive entry escapes destination (tar-slip): ${abs} -> ${real}`);
      }
      if (entry.isDirectory()) {
        await walk(abs);
      }
    }
  }
  await walk(resolvedRoot);
}

// --- Manifest ---------------------------------------------------------------

async function readManifest() {
  try {
    const data = await fsp.readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeManifest(tag, binaryPath, sourceUrl) {
  await fsp.writeFile(
    MANIFEST_PATH,
    JSON.stringify(
      {
        tag,
        binaryPath,
        sourceUrl,
        platform: TARGET_PLATFORM,
        arch: getTargetArch(),
        license: 'LGPL-3.0-or-later',
        notice: 'See NOTICE.md for attribution and source-availability terms.',
        fetchedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

// --- Commands ---------------------------------------------------------------

async function checkRuntime() {
  const binaryPath = path.join(RUNTIME_DIR, FFMPEG_BINARY_NAME);
  const manifest = await readManifest();

  if (
    fs.existsSync(binaryPath) &&
    manifest?.tag &&
    manifest?.platform === TARGET_PLATFORM &&
    manifest?.arch === getTargetArch()
  ) {
    console.log(`FFmpeg runtime present: ${FFMPEG_BINARY_NAME} (tag: ${manifest.tag})`);
    console.log(`  Path: ${binaryPath}`);
    const stat = await fsp.stat(binaryPath);
    console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    return true;
  }

  console.log(`FFmpeg runtime NOT found at: ${binaryPath}`);
  try {
    const asset = getAssetConfig();
    console.log(`  Expected tag: ${asset.tag}`);
    console.log(`  Would download: ${asset.url}`);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
  return false;
}

async function downloadRuntime({ force = false } = {}) {
  const asset = getAssetConfig();
  const binaryDest = path.join(RUNTIME_DIR, FFMPEG_BINARY_NAME);

  if (!force) {
    const manifest = await readManifest();
    // Compare platform AND arch, not just the tag: sequential dual-arch
    // builds on one machine (dist:mac runs arm64 then x64) reuse this
    // directory, and a tag-only check would silently ship the wrong-arch
    // binary in the second leg.
    if (
      manifest?.tag === asset.tag &&
      manifest?.platform === TARGET_PLATFORM &&
      manifest?.arch === getTargetArch() &&
      fs.existsSync(binaryDest)
    ) {
      console.log(
        `FFmpeg runtime already present (tag: ${asset.tag}, ${TARGET_PLATFORM}-${getTargetArch()}). Use --force to re-download.`
      );
      return;
    }
  }

  console.log(`Downloading ffmpeg runtime (${asset.assetName})...`);
  console.log(`  Tag: ${asset.tag}`);
  console.log(`  URL: ${asset.url}`);

  await fsp.mkdir(RUNTIME_DIR, { recursive: true });

  const archivePath = path.join(RUNTIME_DIR, asset.assetName);
  const extractDir = path.join(RUNTIME_DIR, '_extract_tmp');

  try {
    try {
      await downloadFile(asset.url, archivePath);
    } catch (err) {
      // 404/403/410 from the upstream release means the expected asset is no
      // longer reachable. On macOS this happens before the self-hosted LGPL
      // workflow has run at least once; on Windows it usually means BtbN's
      // floating "latest" tag has rolled forward and the previous asset URL
      // was deleted (their release retention is short). In either case the
      // bare "Download failed with HTTP 404" gives the developer no way to
      // recover, so emit a platform-specific actionable hint before rethrowing.
      const message = err && err.message ? err.message : String(err);
      const looks404 = /HTTP 4(?:0[34]|10)/.test(message);
      if (looks404 && TARGET_PLATFORM === 'darwin') {
        console.error('');
        console.error('[setup-ffmpeg-runtime] macOS LGPL FFmpeg release is not yet published.');
        console.error(`  Expected asset: ${asset.url}`);
        console.error('');
        console.error('  To unblock:');
        console.error('    1. Trigger .github/workflows/build-ffmpeg-lgpl.yml on GitHub');
        console.error(
          '       (one-click workflow_dispatch). It uploads ffmpeg-mac-{x64,arm64}.zip'
        );
        console.error(`       to a release tagged "${asset.tag}".`);
        console.error('  OR for a local dev build (no LGPL FFmpeg bundled):');
        console.error(
          '    2. Re-run with SKIP_FFMPEG_RUNTIME=true; MediaTranscoder.resolveFfmpegPath()'
        );
        console.error('       will fall back to system ffmpeg in PATH at runtime.');
        console.error('');
      } else if (looks404 && TARGET_PLATFORM === 'win32') {
        console.error('');
        console.error('[setup-ffmpeg-runtime] BtbN/FFmpeg-Builds asset not reachable.');
        console.error(`  Expected asset: ${asset.url}`);
        console.error('');
        console.error('  BtbN rotates the "latest" tag frequently and deletes older assets.');
        console.error('  To unblock:');
        console.error('    1. Set STRATOSORT_FFMPEG_TAG to a current tag from');
        console.error('       https://github.com/BtbN/FFmpeg-Builds/releases');
        console.error(
          '    2. Or set STRATOSORT_FFMPEG_URL to a self-hosted .zip URL (must be HTTPS,'
        );
        console.error('       hostname must be on the runtime allowlist).');
        console.error('  OR for a local dev build (no LGPL FFmpeg bundled):');
        console.error(
          '    3. Re-run with SKIP_FFMPEG_RUNTIME=true; MediaTranscoder.resolveFfmpegPath()'
        );
        console.error('       will fall back to system ffmpeg in PATH at runtime.');
        console.error('');
      }
      throw err;
    }

    await fsp.mkdir(extractDir, { recursive: true });
    console.log('  Extracting...');
    await extractArchive(archivePath, extractDir, asset.archiveType);

    const foundBinary = await findBinaryInDir(extractDir, FFMPEG_BINARY_NAME);
    if (!foundBinary) {
      throw new Error(`${FFMPEG_BINARY_NAME} not found in extracted archive`);
    }

    // Copy only the ffmpeg binary; static LGPL builds need no sibling DLLs.
    // ffprobe is in the same archive but unused by this codebase — skipped
    // to minimize installer size.
    await fsp.copyFile(foundBinary, binaryDest);

    if (process.platform !== 'win32') {
      try {
        await fsp.chmod(binaryDest, 0o755);
      } catch {
        // Non-fatal
      }
    }

    await writeManifest(asset.tag, binaryDest, asset.url);

    const stat = await fsp.stat(binaryDest);
    console.log(
      `FFmpeg runtime ready: ${FFMPEG_BINARY_NAME} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`
    );
    console.log('  License: LGPL-3.0-or-later (see assets/runtime/ffmpeg/NOTICE.md)');
  } finally {
    await fsp.unlink(archivePath).catch(() => {});
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (process.env.SKIP_FFMPEG_RUNTIME === 'true' || process.env.SKIP_FFMPEG_RUNTIME === '1') {
    console.log('[setup-ffmpeg-runtime] Skipped (SKIP_FFMPEG_RUNTIME is set)');
    return;
  }

  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const present = await checkRuntime();
    process.exit(present ? 0 : 1);
  } else if (args.includes('--force')) {
    await downloadRuntime({ force: true });
  } else {
    await downloadRuntime();
  }
}

main().catch((error) => {
  console.error(`[setup-ffmpeg-runtime] Error: ${error.message}`);
  process.exit(1);
});
