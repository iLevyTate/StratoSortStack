const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAC_V8_CONTEXT_SNAPSHOT_BY_ARCH,
  REQUIRED_ELECTRON_RUNTIME_FILES,
  REQUIRED_NATIVE_MODULE_PATHS,
  getRequiredWhisperVariantPackages,
  verifyMacArtifacts,
  verifyWindowsArtifacts
} = require('../scripts/verify-packaged-artifacts');

function writeFile(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, 'test');
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
}

function seedWhisperVariants(unpackedModules, platform, arch) {
  getRequiredWhisperVariantPackages(platform, arch).forEach((packageName) => {
    const segments = packageName.split('/');
    fs.mkdirSync(path.join(unpackedModules, ...segments), { recursive: true });
  });
}

function createWindowsBuildRoot({ skipWhisperVariants = false } = {}) {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-packaged-artifacts-'));
  const appRoot = path.join(buildRoot, 'win-unpacked');
  const resources = path.join(appRoot, 'resources');
  const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules');

  writeFile(path.join(appRoot, 'StratoSort Stack.exe'));
  REQUIRED_ELECTRON_RUNTIME_FILES.forEach((fileName) => {
    writeFile(path.join(appRoot, fileName));
  });
  writeFile(path.join(resources, 'app.asar'));
  writeFile(path.join(resources, 'assets', 'runtime', 'llama-server.exe'));
  writeExecutable(path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg.exe'));

  seedNativeModules(unpackedModules);
  if (!skipWhisperVariants) {
    seedWhisperVariants(unpackedModules, 'win32', 'x64');
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
  writeFile(path.join(resources, 'app.asar'));
  writeFile(path.join(resources, 'assets', 'runtime', 'llama-server'));
  writeExecutable(path.join(resources, 'assets', 'runtime', 'ffmpeg', 'ffmpeg'));

  seedNativeModules(unpackedModules);
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

    expect(() => verifyWindowsArtifacts(buildRoot)).not.toThrow();
  });

  test('rejects Windows builds missing runtime snapshot files', () => {
    const buildRoot = createWindowsBuildRoot();
    tempDirs.push(buildRoot);
    fs.rmSync(path.join(buildRoot, 'win-unpacked', 'v8_context_snapshot.bin'));

    expect(() => verifyWindowsArtifacts(buildRoot)).toThrow(
      /Windows runtime file v8_context_snapshot\.bin missing/
    );
  });

  test('accepts macOS x64 builds with the Electron 41 snapshot filename', () => {
    const buildRoot = createMacBuildRoot({ arch: 'x64' });
    tempDirs.push(buildRoot);

    expect(() => verifyMacArtifacts(buildRoot, 'x64')).not.toThrow();
  });

  test('accepts macOS arm64 builds with the Electron 41 snapshot filename', () => {
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

    expect(() => verifyWindowsArtifacts(buildRoot)).toThrow(
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

    expect(() => verifyWindowsArtifacts(buildRoot)).toThrow(
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

    expect(() => verifyWindowsArtifacts(buildRoot)).toThrow(
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
