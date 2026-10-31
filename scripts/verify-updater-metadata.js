#!/usr/bin/env node

/**
 * Validates updater metadata files reference artifacts that exist in build output,
 * and that the SHA-512 hash recorded in each metadata entry matches the on-disk bytes.
 *
 * Without the SHA-512 check, a packaging misstep that corrupts the installer but
 * leaves latest*.yml intact would still "pass" upload - and then auto-update would
 * brick on every client with `ERR_UPDATER_INVALID_FILE_HASH`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs() {
  const args = process.argv.slice(2);
  const output = {};

  args.forEach((arg) => {
    if (!arg.startsWith('--')) return;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    output[rawKey] = rawValue === undefined ? true : rawValue;
  });

  return output;
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} missing: ${targetPath}`);
  }
}

function listFiles(buildRoot) {
  return fs
    .readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/**
 * Extract the `files:` array from an electron-updater YAML metadata file without
 * pulling in js-yaml. Each entry is `{ url, sha512, size }`. We only care about
 * url and sha512 for validation purposes.
 */
function extractFileEntries(metadataFilePath) {
  const content = fs.readFileSync(metadataFilePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const entries = [];

  // `files:` array first, in document order — electron-updater's Provider.findFile
  // falls back to the FIRST matching entry when no url contains process.arch, so
  // order is part of the contract verifyWin checks.
  let inFiles = false;
  let current = null;
  for (const rawLine of lines) {
    if (/^files:\s*$/.test(rawLine)) {
      inFiles = true;
      current = null;
      continue;
    }
    if (!inFiles) continue;

    // Any top-level key (not indented) ends the files: list.
    if (rawLine.length > 0 && !/^\s/.test(rawLine) && !/^\s*$/.test(rawLine)) {
      inFiles = false;
      if (current) entries.push(current);
      current = null;
      continue;
    }

    const startEntry = rawLine.match(/^\s*-\s*url:\s*(.+)\s*$/);
    if (startEntry) {
      if (current) entries.push(current);
      current = {
        url: String(startEntry[1] || '')
          .trim()
          .replace(/^['"]|['"]$/g, ''),
        sha512: null,
        source: 'files'
      };
      continue;
    }

    if (current) {
      const shaLine = rawLine.match(/^\s*sha512:\s*(.+)\s*$/);
      if (shaLine) {
        current.sha512 = String(shaLine[1] || '')
          .trim()
          .replace(/^['"]|['"]$/g, '');
      }
    }
  }
  if (current) entries.push(current);

  // Legacy top-level `path:` + `sha512:` pair (electron-updater 1.x compatibility).
  const topPath = content.match(/^path:\s*(.+)$/m);
  const topSha = content.match(/^sha512:\s*(.+)$/m);
  if (topPath && topSha) {
    entries.push({
      url: String(topPath[1] || '')
        .trim()
        .replace(/^['"]|['"]$/g, ''),
      sha512: String(topSha[1] || '')
        .trim()
        .replace(/^['"]|['"]$/g, ''),
      source: 'path'
    });
  }

  // Normalize URL -> basename and decode percent-escapes.
  return entries
    .map((entry) => ({
      name: path.basename(decodeURIComponent(entry.url || '')),
      sha512: entry.sha512,
      source: entry.source
    }))
    .filter((entry) => entry.name);
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('base64');
}

function verifyEntries(metadataName, metadataPath, buildRoot, files) {
  const entries = extractFileEntries(metadataPath);
  if (entries.length === 0) {
    throw new Error(`${metadataName} has no parseable file entries`);
  }

  entries.forEach((entry) => {
    if (!files.includes(entry.name)) {
      throw new Error(`${metadataName} references missing artifact: ${entry.name}`);
    }

    // Blockmaps are referenced but don't always carry a sha512 in older builder output;
    // enforce hash verification only when one is present.
    if (!entry.sha512) {
      if (!/\.blockmap$/i.test(entry.name)) {
        throw new Error(`${metadataName} entry for ${entry.name} has no sha512 hash`);
      }
      return;
    }

    const actual = sha512Base64(path.join(buildRoot, entry.name));
    if (actual !== entry.sha512) {
      throw new Error(
        `${metadataName} sha512 mismatch for ${entry.name}: metadata=${entry.sha512.slice(0, 16)}... actual=${actual.slice(0, 16)}...`
      );
    }
  });
}

const MAC_CHANNEL_FILE = 'latest-mac.yml';
const WIN_CHANNEL_FILE = 'latest.yml';
const MERGE_HINT = 'merge per-arch files with scripts/merge-updater-metadata.js';

/**
 * electron-updater requests exactly `latest-mac.yml` on darwin (no arch suffix;
 * see Provider.getChannelFilePrefix), then picks the zip for its own arch out of
 * `files:` (MacUpdater.filterFilesForArch). One canonical file must therefore
 * reference every arch's zip. Arch-suffixed `latest-mac-<arch>.yml` are release
 * staging names only and must never reach the build root being verified.
 */
function verifyMac(buildRoot) {
  const files = listFiles(buildRoot);

  const staging = files.filter((name) => /^latest-mac-.+\.yml$/i.test(name));
  if (staging.length > 0) {
    throw new Error(
      `Unexpected arch-suffixed macOS updater metadata (${staging.join(', ')}); macOS clients only request ${MAC_CHANNEL_FILE} — ${MERGE_HINT}.`
    );
  }
  if (!files.includes(MAC_CHANNEL_FILE)) {
    throw new Error(`Missing canonical macOS updater metadata file: ${MAC_CHANNEL_FILE}`);
  }

  const metadataPath = path.join(buildRoot, MAC_CHANNEL_FILE);
  const entryNames = extractFileEntries(metadataPath).map((entry) => entry.name);
  for (const macArch of ['x64', 'arm64']) {
    const artifactRe = new RegExp(`-mac-${macArch}\\.(zip|dmg)$`, 'i');
    const zipRe = new RegExp(`-mac-${macArch}\\.zip$`, 'i');
    if (files.some((name) => artifactRe.test(name)) && !entryNames.some((n) => zipRe.test(n))) {
      throw new Error(
        `${MAC_CHANNEL_FILE} does not reference the macOS ${macArch} zip although ${macArch} artifacts are present — ${MERGE_HINT}.`
      );
    }
  }

  verifyEntries(MAC_CHANNEL_FILE, metadataPath, buildRoot, files);
}

/**
 * electron-updater requests exactly `latest.yml` on win32 for every arch
 * (Provider.getChannelFilePrefix returns '' on Windows). NsisUpdater then calls
 * Provider.findFile, which prefers the `.exe` whose url contains process.arch
 * and otherwise falls back to the FIRST `.exe` — the x64 installer name carries
 * no arch token, so it must be listed before the arm64 one.
 *
 * `arch` scopes the artifact checks to a single matrix leg's build root; the
 * merged publish root is verified with arch=null.
 */
function verifyWin(buildRoot, arch = null) {
  const files = listFiles(buildRoot);

  const staging = files.filter(
    (name) => /^latest.*\.yml$/i.test(name) && name !== WIN_CHANNEL_FILE
  );
  if (staging.length > 0) {
    throw new Error(
      `Unexpected arch-suffixed Windows updater metadata (${staging.join(', ')}); Windows clients only request ${WIN_CHANNEL_FILE} — ${MERGE_HINT}.`
    );
  }
  if (!files.includes(WIN_CHANNEL_FILE)) {
    throw new Error(`Missing canonical Windows updater metadata file: ${WIN_CHANNEL_FILE}`);
  }

  const isArm64Exe = (name) => /-arm64\.exe$/i.test(name);
  const isX64Exe = (name) => /\.exe$/i.test(name) && !isArm64Exe(name);
  const checkX64 = !arch || arch === 'x64';
  const checkArm64 = !arch || arch === 'arm64';

  const metadataPath = path.join(buildRoot, WIN_CHANNEL_FILE);
  const entries = extractFileEntries(metadataPath);
  const listedExes = entries
    .filter((entry) => entry.source === 'files')
    .map((entry) => entry.name)
    .filter((name) => /\.exe$/i.test(name));
  const allNames = entries.map((entry) => entry.name);

  // Only the NSIS installers may be offered as updates. The no-install
  // -win-x64.zip is a manual download: app-builder-lib writes update info for
  // Windows nsis/appx targets only (PublishManager isSuitableWindowsTarget), and
  // its writeUpdateInfoFiles sorts .zip entries first, so a zip that ever
  // slipped in would also take over the legacy path/sha512 fields.
  const nonInstallers = allNames.filter((name) => !/\.exe$/i.test(name));
  if (nonInstallers.length > 0) {
    throw new Error(
      `${WIN_CHANNEL_FILE} must list only the NSIS installers, found: ${nonInstallers.join(', ')}.`
    );
  }

  if (checkX64 && files.some(isX64Exe) && !allNames.some(isX64Exe)) {
    throw new Error(
      `${WIN_CHANNEL_FILE} does not reference the x64 installer although one is present — ${MERGE_HINT}.`
    );
  }
  if (checkArm64 && files.some(isArm64Exe) && !allNames.some(isArm64Exe)) {
    throw new Error(
      `${WIN_CHANNEL_FILE} does not reference the arm64 installer although one is present — ${MERGE_HINT}.`
    );
  }
  if (listedExes.some(isX64Exe) && listedExes.some(isArm64Exe) && isArm64Exe(listedExes[0])) {
    throw new Error(
      `${WIN_CHANNEL_FILE} lists the arm64 installer before the x64 one; electron-updater serves the first .exe to x64 clients — pass the x64 channel file first when merging.`
    );
  }

  verifyEntries(WIN_CHANNEL_FILE, metadataPath, buildRoot, files);
}

const LINUX_ARM64_ARTIFACT_RE = /-linux-(arm64|aarch64)\.(AppImage|deb)$/i;
const LINUX_X64_ARTIFACT_RE = /-linux-(x64|x86_64|amd64)\.(AppImage|deb)$/i;
const LINUX_METADATA_RE = /^latest(-linux(-arm64)?)?\.yml$/i;

function classifyLinuxArtifacts(files) {
  return {
    arm64: files.filter((name) => LINUX_ARM64_ARTIFACT_RE.test(name)),
    x64: files.filter((name) => LINUX_X64_ARTIFACT_RE.test(name))
  };
}

function selectLinuxMetadataFiles(files, arch = null) {
  const metadataFiles = files.filter((name) => LINUX_METADATA_RE.test(name));
  if (!arch) {
    return metadataFiles;
  }
  if (arch === 'arm64') {
    return metadataFiles.filter((name) => /arm64/i.test(name));
  }
  if (arch === 'x64') {
    return metadataFiles.filter((name) => !/arm64/i.test(name));
  }
  throw new Error(`Unsupported Linux arch filter: ${arch}`);
}

function verifyLinux(buildRoot, arch = null) {
  const files = listFiles(buildRoot);
  const { arm64: linuxArm64Artifacts, x64: linuxX64Artifacts } = classifyLinuxArtifacts(files);
  const checkX64 = !arch || arch === 'x64';
  const checkArm64 = !arch || arch === 'arm64';

  // Per-matrix CI legs only ship one architecture. After the arm64 leg renames
  // latest-linux.yml -> latest-linux-arm64.yml, a verifier that still expects x64
  // metadata in the same folder will fail even though publish merges both feeds.
  if (checkX64 && linuxX64Artifacts.length > 0) {
    const has = files.includes('latest-linux.yml') || files.includes('latest.yml');
    if (!has) {
      throw new Error(
        'Missing Linux x64 updater metadata (expected latest-linux.yml or latest.yml).'
      );
    }
  }
  if (checkArm64 && linuxArm64Artifacts.length > 0) {
    if (!files.includes('latest-linux-arm64.yml')) {
      throw new Error('Missing Linux arm64 updater metadata (expected latest-linux-arm64.yml).');
    }
  }

  const metadataFiles = selectLinuxMetadataFiles(files, arch);
  if (metadataFiles.length === 0) {
    throw new Error('Missing Linux updater metadata (expected latest.yml or latest-linux*.yml).');
  }
  metadataFiles.forEach((metadataName) => {
    verifyEntries(metadataName, path.join(buildRoot, metadataName), buildRoot, files);
  });
}

function run() {
  const args = parseArgs();
  const platform = String(args.platform || '').toLowerCase();
  const arch = args.arch ? String(args.arch).toLowerCase() : null;
  const buildRoot = path.resolve(
    __dirname,
    '..',
    String(args['build-root'] || path.join('release', 'build'))
  );

  if (!platform || (platform !== 'mac' && platform !== 'win' && platform !== 'linux')) {
    throw new Error(
      'Usage: node scripts/verify-updater-metadata.js --platform=mac|win|linux [--arch=x64|arm64] [--build-root=release/build]'
    );
  }
  if (arch && arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported --arch value: ${arch} (expected x64 or arm64).`);
  }
  if (arch && platform !== 'linux' && platform !== 'win') {
    throw new Error('--arch is only supported with --platform=linux or --platform=win.');
  }

  ensureExists(buildRoot, 'Build output root');
  if (platform === 'mac') {
    verifyMac(buildRoot);
  } else if (platform === 'win') {
    verifyWin(buildRoot, arch);
  } else {
    verifyLinux(buildRoot, arch);
  }

  const archSuffix = arch ? ` arch=${arch}` : '';
  console.log(
    `Updater metadata verification passed for platform=${platform}${archSuffix} (incl. sha512).`
  );
}

module.exports = {
  classifyLinuxArtifacts,
  selectLinuxMetadataFiles,
  verifyLinux,
  verifyMac,
  verifyWin
};

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Updater metadata verification failed: ${error?.message || error}`);
    process.exit(1);
  }
}
