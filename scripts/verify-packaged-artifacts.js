#!/usr/bin/env node

/**
 * Validates packaged build outputs contain runtime-critical files.
 * This catches missing unpacked native modules and runtime assets.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_NATIVE_MODULE_PATHS = [
  ['sharp'],
  ['better-sqlite3'],
  ['@napi-rs', 'canvas'],
  ['lz4-napi'],
  ['node-llama-cpp'],
  ['@node-llama-cpp'],
  ['@fugood', 'whisper.node']
];

/**
 * Whisper platform-variant packages that MUST ship per platform/arch.
 *
 * The parent `@fugood/whisper.node` package only contains the JS binding —
 * the actual native `.node` lives in a per-platform/per-GPU variant package
 * declared as an `optionalDependencies` entry of the parent. npm installs
 * matching variants based on platform/arch detection at install time, but
 * electron-builder's asar walker can silently drop optional transitives if
 * the dep tree changes shape (lockfile churn, npm version differences, a
 * future "prune optional" flag in CI). Without this check, a packaging
 * regression ships a build whose `WhisperService.loadNativeWhisperModule`
 * fails with MODULE_NOT_FOUND for every variant in the chain at runtime,
 * silently disabling all media transcription.
 *
 * Required floor per platform:
 *   - Base CPU variant: always required as the final fallback.
 *   - Vulkan variant: required on win32/linux x64+arm64 because Vulkan is
 *     the universal GPU path (works for AMD/Intel/NVIDIA without extra
 *     runtime — Vulkan loader ships with GPU drivers) and is the GPU-when-
 *     able guarantee for non-NVIDIA users.
 *   - CUDA variant: required on win32/x64 and linux x64+arm64 to give NVIDIA
 *     users the fast path. Falls back to Vulkan if cudart64_*.dll missing from
 *     PATH. NOT required on win32/arm64 — @fugood never published
 *     node-whisper-win32-arm64-cuda (no CUDA toolkit for Windows-on-Arm).
 *   - macOS: only base variant — Metal acceleration is compiled into the
 *     default darwin package; no separate GPU variant exists.
 */
function getRequiredWhisperVariantPackages(platform, arch) {
  const platformKey = String(platform || '').toLowerCase();
  const archKey = String(arch || '').toLowerCase();
  const platformAlias = platformKey === 'win' ? 'win32' : platformKey;
  if (platformAlias === 'darwin' || platformAlias === 'mac') {
    const macPlatformKey = 'darwin';
    if (archKey !== 'x64' && archKey !== 'arm64') {
      return [
        `@fugood/node-whisper-${macPlatformKey}-x64`,
        `@fugood/node-whisper-${macPlatformKey}-arm64`
      ];
    }
    return [`@fugood/node-whisper-${macPlatformKey}-${archKey}`];
  }
  if (platformAlias !== 'win32' && platformAlias !== 'linux') {
    return [];
  }
  const archesToCheck = archKey === 'x64' || archKey === 'arm64' ? [archKey] : ['x64', 'arm64'];
  const required = [];
  for (const platformArch of archesToCheck) {
    required.push(`@fugood/node-whisper-${platformAlias}-${platformArch}`);
    required.push(`@fugood/node-whisper-${platformAlias}-${platformArch}-vulkan`);
    if (platformAlias !== 'win32' || platformArch !== 'arm64') {
      required.push(`@fugood/node-whisper-${platformAlias}-${platformArch}-cuda`);
    }
  }
  return required;
}
/**
 * node-llama-cpp ships its build-from-source inputs (a 36 MB llama.cpp git
 * bundle, the addon C++ sources, cmake files, project templates), which
 * electron-builder.json excludes because getLlama never builds inside Electron
 * (its default `build` option is "never" when process.versions.electron is set).
 * Check both directions: the file node-llama-cpp reads with a top-level await
 * at import time must still ship, and the git bundle must stay out.
 */
const NODE_LLAMA_CPP_RUNTIME_FILES = [['node-llama-cpp', 'llama', 'binariesGithubRelease.json']];
const NODE_LLAMA_CPP_BUILD_ONLY_FILES = [['node-llama-cpp', 'llama', 'gitRelease.bundle']];

/**
 * node-llama-cpp prebuilt packages that must ship per Windows arch, matching
 * getPrebuiltBinariesPackageDirectoryForBuildOptions in
 * node-llama-cpp/dist/bindings/utils/compileLLamaCpp.js. win-x64-cuda-ext holds
 * the CUDA 12 build of ggml-cuda.dll that node-llama-cpp loads from its
 * `fallback/` folder when the CUDA 13 primary cannot load, which is the only
 * CUDA path for a machine whose CUDA runtime DLLs are version 12 (including the
 * cudart 12.4 DLLs the vision runtime downloads). See docs/RELEASING.md.
 */
function getRequiredLlamaPrebuiltPackages(platform, arch) {
  const platformKey = String(platform || '').toLowerCase();
  if (platformKey !== 'win' && platformKey !== 'win32') return [];
  if (String(arch || '').toLowerCase() === 'arm64') return ['@node-llama-cpp/win-arm64'];
  return [
    '@node-llama-cpp/win-x64',
    '@node-llama-cpp/win-x64-cuda',
    '@node-llama-cpp/win-x64-cuda-ext',
    '@node-llama-cpp/win-x64-vulkan'
  ];
}

/**
 * node-llama-cpp prebuilt packages for the OTHER Windows arch, which the top-level
 * "files" rule `win-!(${arch}|${arch}-*)` excludes. @node-llama-cpp/win-arm64
 * declares `cpu: ["arm64", "x64"]`, so npm installs it on x64 runners too.
 */
function getForeignArchLlamaPrebuiltPackages(platform, arch) {
  const platformKey = String(platform || '').toLowerCase();
  if (platformKey !== 'win' && platformKey !== 'win32') return [];
  return String(arch || '').toLowerCase() === 'arm64'
    ? getRequiredLlamaPrebuiltPackages(platform, 'x64')
    : getRequiredLlamaPrebuiltPackages(platform, 'arm64');
}

const BETTER_SQLITE3_NODE_PLATFORM = {
  win: 'win32',
  win32: 'win32',
  mac: 'darwin',
  darwin: 'darwin',
  linux: 'linux'
};

/**
 * better-sqlite3 prebuilds one build may carry. lib/binding.js
 * getPrebuildPath() loads `<platform>-<arch>.node`, or on Linux
 * `linuxmusl-<arch>.node` when glibc is absent, so that one may ship too.
 * electron-builder.json excludes every other prebuild per platform. Without
 * the matching file binding.js falls back to build/Release, which is not
 * packaged, and SQLite fails to load. An empty arch is x64, electron-builder's
 * default.
 *
 * @returns {{ required: string[], allowed: string[] }}
 */
function getBetterSqlitePrebuilds(platform, arch) {
  const nodePlatform = BETTER_SQLITE3_NODE_PLATFORM[String(platform || '').toLowerCase()];
  if (!nodePlatform) return { required: [], allowed: [] };
  const normalizedArch = String(arch || '').toLowerCase() || 'x64';
  const required = [`${nodePlatform}-${normalizedArch}.node`];
  const allowed =
    nodePlatform === 'linux' ? [...required, `linuxmusl-${normalizedArch}.node`] : required;
  return { required, allowed };
}

/** True when `dir` holds at least one file at any depth. */
function containsAnyFile(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some((entry) => (entry.isDirectory() ? containsAnyFile(path.join(dir, entry.name)) : true));
}

/**
 * The Windows x64 no-install artifact (electron-builder `zip` target, named by
 * the top-level artifactName). arm64 ships the installer only.
 */
function getWindowsZipArtifactName(version) {
  return `StratoSortStack-${version}-win-x64.zip`;
}

function readPackageVersion() {
  return require(path.join(__dirname, '..', 'package.json')).version;
}

const REQUIRED_ELECTRON_RUNTIME_FILES = [
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'icudtl.dat'
];
const MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH = {
  x64: 'v8_context_snapshot.x86_64.bin',
  arm64: 'v8_context_snapshot.arm64.bin'
};

function getRequiredMacElectronRuntimeFiles(arch) {
  const normalizedArch = String(arch || '').toLowerCase();
  const v8Snapshot = MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH[normalizedArch];

  if (v8Snapshot) {
    return ['icudtl.dat', v8Snapshot];
  }

  return ['icudtl.dat', ...Object.values(MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH)];
}

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

/**
 * Verify a binary is BOTH present AND executable. Mirrors the runtime gate
 * in MediaTranscoder.resolveFfmpegPath(), which falls back to PATH when a
 * bundled binary exists but lacks the execute bit (chmod stripped during
 * extract, AV quarantine, etc.). Without this check, a packaging regression
 * that loses the +x bit on bundled ffmpeg ships silently broken — verifier
 * passes, runtime fails. Skipped on Windows because X_OK there is best-
 * effort (libuv ACL→GENERIC_EXECUTE mapping is unreliable for files
 * extracted via Windows Explorer; spawn ENOENT/EACCES surfaces real
 * failures at runtime via the SERVICE_UNAVAILABLE classifier).
 */
function ensureExecutable(targetPath, label) {
  ensureExists(targetPath, label);
  if (process.platform === 'win32') return;
  try {
    fs.accessSync(targetPath, fs.constants.X_OK);
  } catch (err) {
    throw new Error(
      `${label} is not executable (${err.code}): ${targetPath}. ` +
        `MediaTranscoder.resolveFfmpegPath would fall back to PATH at runtime, masking the failure.`,
      { cause: err }
    );
  }
}

/**
 * What app.asar may hold at its top level: the webpack output, package.json,
 * the production dependencies and src/shared (the top-level "files" in
 * electron-builder.json). Anything else means a "files" matcher fell back to
 * `**\/*` and packed the project folder, as 5.1.0 did (.webpack-cache, docs,
 * src/main, test: about 300 MB).
 */
const ALLOWED_ASAR_ENTRIES = {
  dist: null,
  node_modules: null,
  'package.json': null,
  src: ['shared']
};

/**
 * Reads the JSON header of an asar archive: a uint32 size pickle (4, header
 * size) followed by the header pickle (payload size, string length, JSON).
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizePickle = Buffer.alloc(8);
    fs.readSync(fd, sizePickle, 0, 8, 0);
    const headerPickle = Buffer.alloc(sizePickle.readUInt32LE(4));
    fs.readSync(fd, headerPickle, 0, headerPickle.length, 8);
    const jsonLength = headerPickle.readUInt32LE(4);
    return JSON.parse(headerPickle.toString('utf8', 8, 8 + jsonLength));
  } finally {
    fs.closeSync(fd);
  }
}

function verifyAsarContents(asarPath, label) {
  ensureExists(asarPath, label);
  let header;
  try {
    header = readAsarHeader(asarPath);
  } catch (err) {
    throw new Error(`${label} has no readable asar header: ${asarPath}`, { cause: err });
  }
  const unexpected = [];
  Object.entries(header.files || {}).forEach(([name, entry]) => {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_ASAR_ENTRIES, name)) {
      unexpected.push(name);
      return;
    }
    const allowedChildren = ALLOWED_ASAR_ENTRIES[name];
    if (allowedChildren && entry.files) {
      Object.keys(entry.files)
        .filter((child) => !allowedChildren.includes(child))
        .forEach((child) => unexpected.push(`${name}/${child}`));
    }
  });
  if (unexpected.length > 0) {
    throw new Error(
      `${label} contains files that are not part of the app: ${unexpected.sort().join(', ')}. ` +
        'Keep every "files" rule in the top-level list of electron-builder.json; a string list ' +
        'under win/mac/linux becomes its own matcher, which packs the whole project folder.'
    );
  }
}

function verifyRequiredFiles(basePath, fileNames, labelPrefix) {
  fileNames.forEach((fileName) => {
    ensureExists(path.join(basePath, fileName), `${labelPrefix} ${fileName}`);
  });
}

function findMacAppBundles(buildRoot, arch) {
  const entries = fs
    .readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => entry.name);

  let ordered = entries;
  if (arch) {
    const archMatches = entries.filter((name) => name.includes(arch));
    if (archMatches.length > 0) {
      ordered = archMatches;
    } else if (entries.includes('mac')) {
      // electron-builder can emit a plain "mac" directory for single-arch builds.
      ordered = ['mac'];
    } else {
      throw new Error(`No mac build directory matched requested arch "${arch}" in ${buildRoot}`);
    }
  }

  const found = [];
  for (const dirName of ordered) {
    const appPath = path.join(buildRoot, dirName, 'StratoSort Stack.app');
    if (fs.existsSync(appPath)) {
      found.push(appPath);
    }
  }

  if (found.length > 0) {
    return found;
  }

  throw new Error(
    `No mac app bundle found in ${buildRoot} (arch=${arch || 'any'}; searched: ${ordered.join(', ') || 'none'})`
  );
}

function verifyNativeModuleFolders(unpackedNodeModulesRoot) {
  REQUIRED_NATIVE_MODULE_PATHS.forEach((segments) => {
    const modulePath = path.join(unpackedNodeModulesRoot, ...segments);
    ensureExists(modulePath, `Unpacked native module ${segments.join('/')}`);
  });
}

function verifyNodeLlamaCppPayload(unpackedNodeModulesRoot) {
  NODE_LLAMA_CPP_RUNTIME_FILES.forEach((segments) => {
    ensureExists(
      path.join(unpackedNodeModulesRoot, ...segments),
      `node-llama-cpp runtime file ${segments.join('/')} (read when the module is imported)`
    );
  });
  NODE_LLAMA_CPP_BUILD_ONLY_FILES.forEach((segments) => {
    const targetPath = path.join(unpackedNodeModulesRoot, ...segments);
    if (fs.existsSync(targetPath)) {
      throw new Error(
        `node-llama-cpp build-only file ${segments.join('/')} was packaged: ${targetPath}. ` +
          'Check the node-llama-cpp exclusions in electron-builder.json "files".'
      );
    }
  });
}

function verifyLlamaPrebuiltPackages(unpackedNodeModulesRoot, platform, arch) {
  getRequiredLlamaPrebuiltPackages(platform, arch).forEach((packageName) => {
    ensureExists(
      path.join(unpackedNodeModulesRoot, ...packageName.split('/')),
      `node-llama-cpp prebuilt package ${packageName}`
    );
  });
  getForeignArchLlamaPrebuiltPackages(platform, arch).forEach((packageName) => {
    const packageDir = path.join(unpackedNodeModulesRoot, ...packageName.split('/'));
    if (containsAnyFile(packageDir)) {
      throw new Error(
        `node-llama-cpp prebuilt package ${packageName} for another arch was packaged: ` +
          `${packageDir}. Check the @node-llama-cpp exclusion in electron-builder.json "files".`
      );
    }
  });
}

function verifyBetterSqlitePrebuilds(unpackedNodeModulesRoot, platform, arch) {
  const prebuildsDir = path.join(unpackedNodeModulesRoot, 'better-sqlite3', 'prebuilds');
  const { required, allowed } = getBetterSqlitePrebuilds(platform, arch);
  required.forEach((fileName) => {
    ensureExists(
      path.join(prebuildsDir, fileName),
      `better-sqlite3 prebuild ${fileName} (lib/binding.js loads it; build/Release is not packaged)`
    );
  });
  if (!fs.existsSync(prebuildsDir)) return;
  const foreign = fs
    .readdirSync(prebuildsDir)
    .filter((name) => name.endsWith('.node') && !allowed.includes(name));
  if (foreign.length > 0) {
    throw new Error(
      `better-sqlite3 prebuilds for another platform or arch were packaged: ${foreign.join(', ')} ` +
        `in ${prebuildsDir}. Check the better-sqlite3 exclusions in electron-builder.json "files".`
    );
  }
}

function verifyWhisperVariantFolders(unpackedNodeModulesRoot, platform, arch) {
  const requiredPackages = getRequiredWhisperVariantPackages(platform, arch);
  requiredPackages.forEach((packageName) => {
    const segments = packageName.split('/');
    const modulePath = path.join(unpackedNodeModulesRoot, ...segments);
    ensureExists(
      modulePath,
      `Whisper variant package ${packageName} (loadNativeWhisperModule fallback chain depends on it)`
    );
  });
}

function verifyWindowsArtifacts(buildRoot, arch, version = readPackageVersion()) {
  // electron-builder emits 'win-unpacked' for the default (x64) arch and
  // 'win-arm64-unpacked' for arm64.
  const isArm64 = arch === 'arm64';
  if (!isArm64) {
    ensureExists(path.join(buildRoot, getWindowsZipArtifactName(version)), 'Windows x64 zip');
  }
  const appRoot = path.join(buildRoot, isArm64 ? 'win-arm64-unpacked' : 'win-unpacked');
  const resources = path.join(appRoot, 'resources');
  const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

  ensureExists(path.join(appRoot, 'StratoSort Stack.exe'), 'Windows executable');
  verifyRequiredFiles(appRoot, REQUIRED_ELECTRON_RUNTIME_FILES, 'Windows runtime file');
  ensureExists(resources, 'Windows resources directory');
  verifyAsarContents(path.join(resources, 'app.asar'), 'Windows app.asar');
  ensureExists(
    path.join(resources, 'assets', 'runtime', 'llama-server.exe'),
    'Windows runtime binary'
  );
  // BtbN ships no win-arm64 LGPL ffmpeg, so the arm64 installer is built with
  // SKIP_FFMPEG_RUNTIME=true and relies on MediaTranscoder's PATH fallback.
  // Only assert the bundled binary on x64.
  if (!isArm64) {
    ensureExecutable(
      path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg.exe'),
      'Windows bundled FFmpeg binary'
    );
  }
  verifyNativeModuleFolders(unpackedModules);
  verifyNodeLlamaCppPayload(unpackedModules);
  verifyLlamaPrebuiltPackages(unpackedModules, 'win32', isArm64 ? 'arm64' : 'x64');
  verifyBetterSqlitePrebuilds(unpackedModules, 'win32', isArm64 ? 'arm64' : 'x64');
  verifyWhisperVariantFolders(unpackedModules, 'win32', isArm64 ? 'arm64' : 'x64');
}

function verifyMacArtifacts(buildRoot, arch) {
  const appBundles = findMacAppBundles(buildRoot, arch);
  appBundles.forEach((appBundle) => {
    const contents = path.join(appBundle, 'Contents');
    const resources = path.join(contents, 'Resources');
    const frameworkResources = path.join(
      contents,
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    );
    const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

    ensureExists(path.join(contents, 'MacOS', 'StratoSort Stack'), 'macOS executable');
    verifyRequiredFiles(
      frameworkResources,
      getRequiredMacElectronRuntimeFiles(arch),
      'macOS runtime file'
    );
    verifyAsarContents(path.join(resources, 'app.asar'), 'macOS app.asar');
    ensureExists(path.join(resources, 'assets', 'runtime', 'llama-server'), 'macOS runtime binary');
    ensureExecutable(
      path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg'),
      'macOS bundled FFmpeg binary'
    );
    verifyNativeModuleFolders(unpackedModules);
    verifyNodeLlamaCppPayload(unpackedModules);
    verifyBetterSqlitePrebuilds(unpackedModules, 'darwin', arch);
    verifyWhisperVariantFolders(unpackedModules, 'darwin', arch);
  });
}

function verifyLinuxArtifacts(buildRoot, arch) {
  // electron-builder emits 'linux-unpacked' for the default (x64) arch and
  // 'linux-arm64-unpacked' for arm64.
  const isArm64 = arch === 'arm64';
  const appRoot = path.join(buildRoot, isArm64 ? 'linux-arm64-unpacked' : 'linux-unpacked');
  const resources = path.join(appRoot, 'resources');
  const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

  ensureExists(appRoot, 'Linux unpacked root');
  verifyRequiredFiles(appRoot, REQUIRED_ELECTRON_RUNTIME_FILES, 'Linux runtime file');
  ensureExists(resources, 'Linux resources directory');
  verifyAsarContents(path.join(resources, 'app.asar'), 'Linux app.asar');
  ensureExists(path.join(resources, 'assets', 'runtime', 'llama-server'), 'Linux vision runtime');
  ensureExecutable(
    path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg'),
    'Linux bundled FFmpeg binary'
  );
  verifyNativeModuleFolders(unpackedModules);
  verifyNodeLlamaCppPayload(unpackedModules);
  verifyBetterSqlitePrebuilds(unpackedModules, 'linux', isArm64 ? 'arm64' : 'x64');
  verifyWhisperVariantFolders(unpackedModules, 'linux', isArm64 ? 'arm64' : 'x64');
}

function run() {
  const args = parseArgs();
  const platform = String(args.platform || '').toLowerCase();
  const arch = args.arch ? String(args.arch).toLowerCase() : '';
  const buildRoot = path.resolve(__dirname, '..', 'release', 'build');

  if (!platform || (platform !== 'win' && platform !== 'mac' && platform !== 'linux')) {
    throw new Error(
      'Usage: node scripts/verify-packaged-artifacts.js --platform=win|mac|linux [--arch=x64|arm64]'
    );
  }

  ensureExists(buildRoot, 'Build output root');

  if (platform === 'win') {
    verifyWindowsArtifacts(buildRoot, arch);
  } else if (platform === 'mac') {
    verifyMacArtifacts(buildRoot, arch);
  } else {
    verifyLinuxArtifacts(buildRoot, arch);
  }

  console.log(
    `Packaged artifact verification passed for platform=${platform}${arch ? ` arch=${arch}` : ''}.`
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Packaged artifact verification failed: ${error?.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  ALLOWED_ASAR_ENTRIES,
  getRequiredLlamaPrebuiltPackages,
  getForeignArchLlamaPrebuiltPackages,
  getBetterSqlitePrebuilds,
  verifyBetterSqlitePrebuilds,
  getRequiredMacElectronRuntimeFiles,
  getRequiredWhisperVariantPackages,
  getWindowsZipArtifactName,
  MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH,
  NODE_LLAMA_CPP_BUILD_ONLY_FILES,
  NODE_LLAMA_CPP_RUNTIME_FILES,
  REQUIRED_ELECTRON_RUNTIME_FILES,
  REQUIRED_NATIVE_MODULE_PATHS,
  findMacAppBundles,
  parseArgs,
  run,
  verifyLinuxArtifacts,
  verifyMacArtifacts,
  verifyNativeModuleFolders,
  readAsarHeader,
  verifyAsarContents,
  verifyRequiredFiles,
  verifyWhisperVariantFolders,
  verifyWindowsArtifacts
};
