const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH,
  NODE_LLAMA_CPP_BUILD_ONLY_FILES,
  NODE_LLAMA_CPP_RUNTIME_FILES,
  REQUIRED_ELECTRON_RUNTIME_FILES,
  REQUIRED_NATIVE_MODULE_PATHS,
  getBetterSqlitePrebuilds,
  getForeignArchLlamaPrebuiltPackages,
  getRequiredLlamaPrebuiltPackages,
  getRequiredWhisperVariantPackages,
  getWindowsZipArtifactName,
  readAsarHeader,
  verifyBetterSqlitePrebuilds,
  verifyMacArtifacts,
  verifyWindowsArtifacts
} = require('../scripts/verify-packaged-artifacts');

const VERSION = '9.9.9';

function writeFile(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, 'test');
}

// The app.asar layout electron-builder produces from the top-level "files".
const APP_ASAR_ENTRIES = {
  dist: { files: { 'main.js': { size: 1, offset: '0' } } },
  node_modules: { files: {} },
  'package.json': { size: 2, offset: '1' },
  src: { files: { shared: { files: {} } } }
};

// Writes an asar header (no file data): a uint32 size pickle followed by the
// header pickle holding the JSON string, padded to 4 bytes.
function writeAsar(targetPath, entries = APP_ASAR_ENTRIES) {
  const json = Buffer.from(JSON.stringify({ files: entries }));
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.concat([sizePickle, headerPickle]));
}

function writeExecutable(targetPath) {
  writeFile(targetPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }
}

function seedNativeModules(unpackedModules) {
  REQUIRED_NATIVE_MODULE_PATHS.forEach((segments) => {
    fs.mkdirSync(path.join(unpackedModules, ...segments), { recursive: true });
  });
  NODE_LLAMA_CPP_RUNTIME_FILES.forEach((segments) => {
    writeFile(path.join(unpackedModules, ...segments));
  });
}

function seedLlamaPrebuilts(unpackedModules, platform, arch) {
  getRequiredLlamaPrebuiltPackages(platform, arch).forEach((packageName) => {
    fs.mkdirSync(path.join(unpackedModules, ...packageName.split('/')), { recursive: true });
  });
}

function seedSqlitePrebuilds(unpackedModules, platform, arch) {
  getBetterSqlitePrebuilds(platform, arch).required.forEach((fileName) => {
    writeFile(path.join(unpackedModules, 'better-sqlite3', 'prebuilds', fileName));
  });
}

function seedWhisperVariants(unpackedModules, platform, arch) {
  getRequiredWhisperVariantPackages(platform, arch).forEach((packageName) => {
    const segments = packageName.split('/');
    fs.mkdirSync(path.join(unpackedModules, ...segments), { recursive: true });
  });
}

function windowsUnpackedModules(buildRoot, arch = 'x64') {
  const appDir = arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
  return path.join(buildRoot, appDir, 'resources', 'app.asar.unpacked', 'node_modules');
}

function createWindowsBuildRoot({ arch = 'x64', skipWhisperVariants = false } = {}) {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-packaged-artifacts-'));
  const appRoot = path.join(buildRoot, arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
  const resources = path.join(appRoot, 'resources');
  const unpackedModules = windowsUnpackedModules(buildRoot, arch);

  writeFile(path.join(appRoot, 'StratoSort Stack.exe'));
  REQUIRED_ELECTRON_RUNTIME_FILES.forEach((fileName) => {
    writeFile(path.join(appRoot, fileName));
  });
  writeAsar(path.join(resources, 'app.asar'));
  writeFile(path.join(resources, 'assets', 'runtime', 'llama-server.exe'));
  if (arch !== 'arm64') {
    writeExecutable(path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg.exe'));
    writeFile(path.join(buildRoot, getWindowsZipArtifactName(VERSION)));
  }

  seedNativeModules(unpackedModules);
  seedLlamaPrebuilts(unpackedModules, 'win32', arch);
  seedSqlitePrebuilds(unpackedModules, 'win32', arch);
  if (!skipWhisperVariants) {
    seedWhisperVariants(unpackedModules, 'win32', arch);
  }

  return buildRoot;
}

function createMacBuildRoot({
  arch = 'x64',
  includeSnapshotBlob = false,
  skipWhisperVariants = false
} = {}) {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-packaged-artifacts-'));
  const bundleDir = arch === 'arm64' ? 'mac-arm64' : 'mac';
  const appRoot = path.join(buildRoot, bundleDir, 'StratoSort Stack.app', 'Contents');
  const resources = path.join(appRoot, 'Resources');
  const frameworkResources = path.join(
    appRoot,
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources'
  );
  const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

  writeFile(path.join(appRoot, 'MacOS', 'StratoSort Stack'));
  writeFile(path.join(frameworkResources, MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH[arch]));
  writeFile(path.join(frameworkResources, 'icudtl.dat'));
  if (includeSnapshotBlob) {
    writeFile(path.join(frameworkResources, 'snapshot_blob.bin'));
  }
  writeAsar(path.join(resources, 'app.asar'));
  writeFile(path.join(resources, 'assets', 'runtime', 'llama-server'));
  writeExecutable(path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg'));

  seedNativeModules(unpackedModules);
  seedSqlitePrebuilds(unpackedModules, 'darwin', arch);
  if (!skipWhisperVariants) {
    seedWhisperVariants(unpackedModules, 'darwin', arch);
  }

  return buildRoot;
}

describe('verify-packaged-artifacts', () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  test('accepts Windows builds with Electron runtime snapshot files', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).not.toThrow();
  });

  test('rejects Windows builds missing runtime snapshot files', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.rmSync(path.join(buildRoot, 'win-unpacked', 'v8_context_snapshot.bin'));

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Windows runtime file v8_context_snapshot\.bin missing/
    );
  });

  test('rejects Windows builds whose app.asar packed the project folder', () => {
    // 5.1.0's app.asar held the webpack cache, docs, src/main and test.
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    writeAsar(path.join(buildRoot, 'win-unpacked', 'resources', 'app.asar'), {
      ...APP_ASAR_ENTRIES,
      '.webpack-cache': { files: {} },
      docs: { files: {} },
      src: { files: { main: { files: {} }, shared: { files: {} } } },
      test: { files: {} }
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Windows app\.asar contains files that are not part of the app: \.webpack-cache, docs, src\/main, test\./
    );
  });

  test('rejects macOS builds whose app.asar packed the project folder', () => {
    const buildRoot = createMacBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);
    writeAsar(
      path.join(
        buildRoot,
        'mac-arm64',
        'StratoSort Stack.app',
        'Contents',
        'Resources',
        'app.asar'
      ),
      { ...APP_ASAR_ENTRIES, 'CLAUDE.md': { size: 1, offset: '3' } }
    );

    expect(() => verifyMacArtifacts(buildRoot, 'arm64')).toThrow(
      /macOS app\.asar contains files that are not part of the app: CLAUDE\.md\./
    );
  });

  test('rejects an app.asar without a readable header', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    writeFile(path.join(buildRoot, 'win-unpacked', 'resources', 'app.asar'));

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Windows app\.asar has no readable asar header/
    );
  });

  test('readAsarHeader returns the archive listing', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);

    const header = readAsarHeader(path.join(buildRoot, 'win-unpacked', 'resources', 'app.asar'));
    expect(Object.keys(header.files).sort()).toEqual([
      'dist',
      'node_modules',
      'package.json',
      'src'
    ]);
  });

  test('accepts macOS x64 builds with the per-arch V8 context snapshot filename', () => {
    const buildRoot = createMacBuildRoot({ arch: 'x64' });
    tempDirs.push(buildRoot);

    expect(() => verifyMacArtifacts(buildRoot, 'x64')).not.toThrow();
  });

  test('accepts macOS arm64 builds with the per-arch V8 context snapshot filename', () => {
    const buildRoot = createMacBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);

    expect(() => verifyMacArtifacts(buildRoot, 'arm64')).not.toThrow();
  });

  test('rejects macOS builds missing the required x64 runtime snapshot file', () => {
    const buildRoot = createMacBuildRoot({ arch: 'x64', includeSnapshotBlob: true });
    tempDirs.push(buildRoot);
    fs.rmSync(
      path.join(
        buildRoot,
        'mac',
        'StratoSort Stack.app',
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Resources',
        MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH.x64
      )
    );

    expect(() => verifyMacArtifacts(buildRoot, 'x64')).toThrow(
      /macOS runtime file v8_context_snapshot\.x86_64\.bin missing/
    );
  });

  test('rejects Windows builds missing the whisper Vulkan variant package', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    const unpackedModules = path.join(
      buildRoot,
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules'
    );
    fs.rmSync(path.join(unpackedModules, '@fugood', 'node-whisper-win32-x64-vulkan'), {
      recursive: true
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Whisper variant package @fugood\/node-whisper-win32-x64-vulkan/
    );
  });

  test('rejects Windows builds missing the whisper CUDA variant package', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    const unpackedModules = path.join(
      buildRoot,
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules'
    );
    fs.rmSync(path.join(unpackedModules, '@fugood', 'node-whisper-win32-x64-cuda'), {
      recursive: true
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Whisper variant package @fugood\/node-whisper-win32-x64-cuda/
    );
  });

  test('rejects Windows builds missing the whisper.node parent package', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    const unpackedModules = path.join(
      buildRoot,
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'node_modules'
    );
    fs.rmSync(path.join(unpackedModules, '@fugood', 'whisper.node'), { recursive: true });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Unpacked native module @fugood\/whisper\.node missing/
    );
  });

  test('rejects macOS arm64 builds missing the darwin-arm64 whisper variant', () => {
    const buildRoot = createMacBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);
    const unpackedModules = path.join(
      buildRoot,
      'mac-arm64',
      'StratoSort Stack.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules'
    );
    fs.rmSync(path.join(unpackedModules, '@fugood', 'node-whisper-darwin-arm64'), {
      recursive: true
    });

    expect(() => verifyMacArtifacts(buildRoot, 'arm64')).toThrow(
      /Whisper variant package @fugood\/node-whisper-darwin-arm64/
    );
  });

  test('rejects Windows x64 builds without the no-install zip', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.rmSync(path.join(buildRoot, getWindowsZipArtifactName(VERSION)));

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /Windows x64 zip missing: .*StratoSortStack-9\.9\.9-win-x64\.zip/
    );
  });

  test('accepts Windows arm64 builds, which ship the installer without a zip', () => {
    const buildRoot = createWindowsBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);

    expect(() => verifyWindowsArtifacts(buildRoot, 'arm64', VERSION)).not.toThrow();
  });

  test('rejects Windows x64 builds missing the CUDA 12 fallback package', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.rmSync(path.join(windowsUnpackedModules(buildRoot), '@node-llama-cpp', 'win-x64-cuda-ext'), {
      recursive: true
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /node-llama-cpp prebuilt package @node-llama-cpp\/win-x64-cuda-ext missing/
    );
  });

  test('rejects Windows x64 builds that packaged the arm64 llama prebuilt', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    writeFile(
      path.join(
        windowsUnpackedModules(buildRoot),
        '@node-llama-cpp',
        'win-arm64',
        'bins',
        'win-arm64',
        'llama-addon.node'
      )
    );

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /prebuilt package @node-llama-cpp\/win-arm64 for another arch was packaged/
    );
  });

  test('accepts an empty directory left by the excluded arm64 llama prebuilt', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.mkdirSync(path.join(windowsUnpackedModules(buildRoot), '@node-llama-cpp', 'win-arm64'), {
      recursive: true
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).not.toThrow();
  });

  test('rejects Windows x64 builds missing their better-sqlite3 prebuild', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.rmSync(
      path.join(windowsUnpackedModules(buildRoot), 'better-sqlite3', 'prebuilds', 'win32-x64.node')
    );

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /better-sqlite3 prebuild win32-x64\.node .* missing/
    );
  });

  test('rejects macOS arm64 builds that also packaged the x64 better-sqlite3 prebuild', () => {
    const buildRoot = createMacBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);
    writeFile(
      path.join(
        buildRoot,
        'mac-arm64',
        'StratoSort Stack.app',
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'darwin-x64.node'
      )
    );

    expect(() => verifyMacArtifacts(buildRoot, 'arm64')).toThrow(
      /better-sqlite3 prebuilds for another platform or arch were packaged: darwin-x64\.node/
    );
  });

  test('Linux builds may carry the musl prebuild for the same arch only', () => {
    const modules = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-sqlite-prebuilds-'));
    tempDirs.push(modules);
    const prebuilds = path.join(modules, 'better-sqlite3', 'prebuilds');
    writeFile(path.join(prebuilds, 'linux-x64.node'));
    writeFile(path.join(prebuilds, 'linuxmusl-x64.node'));

    expect(() => verifyBetterSqlitePrebuilds(modules, 'linux', 'x64')).not.toThrow();

    writeFile(path.join(prebuilds, 'linux-arm64.node'));
    expect(() => verifyBetterSqlitePrebuilds(modules, 'linux', 'x64')).toThrow(
      /another platform or arch were packaged: linux-arm64\.node/
    );
  });

  describe('getBetterSqlitePrebuilds policy', () => {
    test.each([
      ['win', 'x64', ['win32-x64.node'], ['win32-x64.node']],
      ['win32', 'arm64', ['win32-arm64.node'], ['win32-arm64.node']],
      ['mac', 'arm64', ['darwin-arm64.node'], ['darwin-arm64.node']],
      ['linux', '', ['linux-x64.node'], ['linux-x64.node', 'linuxmusl-x64.node']],
      ['linux', 'arm64', ['linux-arm64.node'], ['linux-arm64.node', 'linuxmusl-arm64.node']],
      ['freebsd', 'x64', [], []]
    ])('%s %s', (platform, arch, required, allowed) => {
      expect(getBetterSqlitePrebuilds(platform, arch)).toEqual({ required, allowed });
    });
  });

  test('rejects builds that packaged the node-llama-cpp git bundle', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    NODE_LLAMA_CPP_BUILD_ONLY_FILES.forEach((segments) => {
      writeFile(path.join(windowsUnpackedModules(buildRoot), ...segments));
    });

    expect(() => verifyWindowsArtifacts(buildRoot, 'x64', VERSION)).toThrow(
      /node-llama-cpp build-only file node-llama-cpp\/llama\/gitRelease\.bundle was packaged/
    );
  });

  test('rejects builds missing the release file node-llama-cpp reads on import', () => {
    const buildRoot = createMacBuildRoot({ arch: 'arm64' });
    tempDirs.push(buildRoot);
    fs.rmSync(
      path.join(
        buildRoot,
        'mac-arm64',
        'StratoSort Stack.app',
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-llama-cpp',
        'llama',
        'binariesGithubRelease.json'
      )
    );

    expect(() => verifyMacArtifacts(buildRoot, 'arm64')).toThrow(
      /node-llama-cpp runtime file node-llama-cpp\/llama\/binariesGithubRelease\.json/
    );
  });

  describe('getRequiredLlamaPrebuiltPackages policy', () => {
    test('Windows x64 requires CPU, CUDA, the CUDA 12 fallback and Vulkan packages', () => {
      expect(getRequiredLlamaPrebuiltPackages('win32', 'x64')).toEqual([
        '@node-llama-cpp/win-x64',
        '@node-llama-cpp/win-x64-cuda',
        '@node-llama-cpp/win-x64-cuda-ext',
        '@node-llama-cpp/win-x64-vulkan'
      ]);
    });

    test('Windows arm64 requires only the arm64 package', () => {
      expect(getRequiredLlamaPrebuiltPackages('win', 'arm64')).toEqual([
        '@node-llama-cpp/win-arm64'
      ]);
    });

    test('other platforms are not checked', () => {
      expect(getRequiredLlamaPrebuiltPackages('darwin', 'arm64')).toEqual([]);
      expect(getRequiredLlamaPrebuiltPackages('linux', 'x64')).toEqual([]);
    });

    test("each Windows arch must not ship the other arch's packages", () => {
      expect(getForeignArchLlamaPrebuiltPackages('win32', 'x64')).toEqual([
        '@node-llama-cpp/win-arm64'
      ]);
      expect(getForeignArchLlamaPrebuiltPackages('win', '')).toEqual(['@node-llama-cpp/win-arm64']);
      expect(getForeignArchLlamaPrebuiltPackages('win', 'arm64')).toEqual(
        getRequiredLlamaPrebuiltPackages('win', 'x64')
      );
      expect(getForeignArchLlamaPrebuiltPackages('darwin', 'arm64')).toEqual([]);
    });
  });

  describe('getRequiredWhisperVariantPackages policy', () => {
    test('Windows x64 requires base + Vulkan + CUDA variants', () => {
      expect(getRequiredWhisperVariantPackages('win32', 'x64')).toEqual([
        '@fugood/node-whisper-win32-x64',
        '@fugood/node-whisper-win32-x64-vulkan',
        '@fugood/node-whisper-win32-x64-cuda'
      ]);
    });

    test('Linux x64 requires base + Vulkan + CUDA variants', () => {
      expect(getRequiredWhisperVariantPackages('linux', 'x64')).toEqual([
        '@fugood/node-whisper-linux-x64',
        '@fugood/node-whisper-linux-x64-vulkan',
        '@fugood/node-whisper-linux-x64-cuda'
      ]);
    });

    test('Linux arm64 requires base + Vulkan + CUDA variants', () => {
      expect(getRequiredWhisperVariantPackages('linux', 'arm64')).toEqual([
        '@fugood/node-whisper-linux-arm64',
        '@fugood/node-whisper-linux-arm64-vulkan',
        '@fugood/node-whisper-linux-arm64-cuda'
      ]);
    });

    test('Windows arm64 requires only base + Vulkan (CUDA variant was never published)', () => {
      expect(getRequiredWhisperVariantPackages('win32', 'arm64')).toEqual([
        '@fugood/node-whisper-win32-arm64',
        '@fugood/node-whisper-win32-arm64-vulkan'
      ]);
    });

    test('macOS arm64 requires only the darwin-arm64 base variant (Metal is built in)', () => {
      expect(getRequiredWhisperVariantPackages('darwin', 'arm64')).toEqual([
        '@fugood/node-whisper-darwin-arm64'
      ]);
    });

    test('"win" alias normalizes to "win32"', () => {
      expect(getRequiredWhisperVariantPackages('win', 'x64')).toEqual(
        getRequiredWhisperVariantPackages('win32', 'x64')
      );
    });

    test('"mac" alias normalizes to "darwin"', () => {
      expect(getRequiredWhisperVariantPackages('mac', 'x64')).toEqual(
        getRequiredWhisperVariantPackages('darwin', 'x64')
      );
    });

    test('unknown platform returns empty list rather than throwing', () => {
      expect(getRequiredWhisperVariantPackages('aix', 'x64')).toEqual([]);
    });
  });
});
