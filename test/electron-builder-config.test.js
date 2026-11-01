/**
 * Regression tests for electron-builder.json security configuration.
 * Validates that packaging config values remain safe across changes.
 */

// app-builder-lib loads graceful-fs, which cannot patch the memfs stand-in that
// test-setup.js installs for 'fs'. This file reads nothing from disk.
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const builderConfig = require('../electron-builder.json');

describe('electron-builder.json security config', () => {
  test('NSIS allowElevation is false', () => {
    expect(builderConfig.nsis.allowElevation).toBe(false);
  });

  test('NSIS perMachine is false (user-level install)', () => {
    expect(builderConfig.nsis.perMachine).toBe(false);
  });

  test('NSIS custom install directory is disabled for per-user installs', () => {
    expect(builderConfig.nsis.allowToChangeInstallationDirectory).toBe(false);
  });

  test('ASAR packaging is enabled', () => {
    expect(builderConfig.asar).toBe(true);
  });

  test('appId matches expected value', () => {
    expect(builderConfig.appId).toBe('com.stratosort.app');
  });

  test('macOS hardened runtime is enabled', () => {
    expect(builderConfig.mac.hardenedRuntime).toBe(true);
  });

  test('browser-process-specific V8 snapshot fuse is disabled', () => {
    expect(builderConfig.electronFuses.loadBrowserProcessSpecificV8Snapshot).toBe(false);
  });
});

describe('electron-builder.json Windows targets', () => {
  test('ships the NSIS installer and a zip, and no portable target', () => {
    expect(builderConfig.win.target).toEqual(['nsis', 'zip']);
    expect(builderConfig.portable).toBeUndefined();
  });
});

// The top-level `compression: maximum` turns a zip into 15-pass Deflate
// (-mfb=258 -mpass=15), which ran the x64 release job past its 45-minute limit
// on the CUDA libraries. win.compression overrides it for both Windows targets.
describe('electron-builder.json Windows compression', () => {
  const { compute7zCompressArgs } = require('app-builder-lib/out/targets/archive');
  const winCompression = builderConfig.win.compression;

  test('the Windows zip is not built with 15-pass Deflate', () => {
    expect(winCompression).toBe('normal');
    expect(compute7zCompressArgs('zip', { compression: winCompression })).not.toContain(
      '-mpass=15'
    );
  });

  test('the NSIS app archive keeps the 7z settings it had at maximum', () => {
    expect(compute7zCompressArgs('7z', { compression: winCompression })).toEqual(
      compute7zCompressArgs('7z', { compression: 'maximum' })
    );
  });
});

// electron-builder does not read `files` as written: before packaging it
// normalizes the top-level strings into a `{ filter: [...] }` file set
// (doMergeConfigs) and builds its app and node_modules filters from that plus
// the platform's own options. These helpers run the same steps on the
// committed configs. A string `files` list under win/mac/linux turned into a
// second, exclude-only matcher, which electron-builder starts with `**/*`, so
// 5.1.0 packed the whole project folder into app.asar.
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const {
  getMainFileMatchers,
  getNodeModuleFileMatcher,
  FileMatcher
} = require('app-builder-lib/out/fileMatcher');

const NODE_PLATFORM = { win: 'win32', mac: 'darwin', linux: 'linux' };

function loadNormalizedConfig(configFile) {
  const read = (name) => JSON.parse(JSON.stringify(require(`../${name.replace(/^\.\//, '')}`)));
  const config = read(configFile);
  const parent = config.extends;
  delete config.extends;
  return doMergeConfigs(parent ? [read(parent), config] : [config]);
}

// Each release leg builds on its own OS, so ${platform} (process.platform at
// build time) is the target's Node platform name.
function macroExpanderFor(platformKey, arch) {
  return (pattern) =>
    pattern
      .replace(/\$\{arch\}/g, arch)
      .replace(/\$\{platform\}/g, NODE_PLATFORM[platformKey])
      .replace(/\$\{os\}/g, platformKey);
}

function packagerFor(config) {
  return {
    config,
    projectDir: '/project',
    buildResourcesDir: `/project/${config.directories.buildResources}`,
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false }
  };
}

// Mirrors the copy walk: a file is packaged when some matcher accepts it and
// every folder above it.
function isAppFilePackaged(configFile, platformKey, arch, relativePath) {
  const config = loadNormalizedConfig(configFile);
  const matchers = getMainFileMatchers(
    '/project',
    '/out/app',
    macroExpanderFor(platformKey, arch),
    config[platformKey] || {},
    { info: packagerFor(config) },
    `/project/${config.directories.output}`,
    false
  );
  const segments = relativePath.split('/');
  return matchers.some((matcher) => {
    const filter = matcher.createFilter();
    return segments.every((_, index) => {
      const isDirectory = index < segments.length - 1;
      const moduleFullFilePath = segments.slice(0, index + 1).join('/');
      return filter(`/project/${moduleFullFilePath}`, {
        isDirectory: () => isDirectory,
        moduleFullFilePath
      });
    });
  });
}

function isModulePackaged(platformKey, moduleRelativePath, arch = 'x64', configFile) {
  const config = loadNormalizedConfig(configFile || 'electron-builder.json');
  const macroExpander = macroExpanderFor(platformKey, arch);
  const nodeModuleMatcher = getNodeModuleFileMatcher(
    '/project',
    '/out/app',
    macroExpander,
    config[platformKey] || {},
    packagerFor(config)
  );
  const [, scope, name] = moduleRelativePath.match(/^node_modules\/(@[^/]+\/)?([^/]+)/);
  const depDir = `/project/node_modules/${scope || ''}${name}`;
  const filter = new FileMatcher(
    depDir,
    '/out/app',
    macroExpander,
    nodeModuleMatcher.patterns
  ).createFilter();
  const stat = { isDirectory: () => false, moduleFullFilePath: moduleRelativePath };
  return filter(`/project/${moduleRelativePath}`, stat);
}

const RELEASE_LEGS = [
  ['electron-builder.json', 'win', 'x64'],
  ['electron-builder.win-arm64.json', 'win', 'arm64'],
  ['electron-builder.json', 'mac', 'x64'],
  ['electron-builder.json', 'mac', 'arm64'],
  ['electron-builder.json', 'linux', 'x64'],
  ['electron-builder.json', 'linux', 'arm64']
];

describe('electron-builder app files', () => {
  test.each(RELEASE_LEGS)(
    '%s (%s %s) packages the built app and none of the project tree',
    (configFile, platformKey, arch) => {
      const packaged = (relativePath) =>
        isAppFilePackaged(configFile, platformKey, arch, relativePath);
      ['dist/main.js', 'dist/index.html', 'package.json', 'src/shared/logger.js'].forEach(
        (relativePath) =>
          expect([relativePath, packaged(relativePath)]).toEqual([relativePath, true])
      );
      [
        '.webpack-cache/default-production/0.pack',
        'docs/assets/screenshot.png',
        'docs/walkthrough-assets/step-1.png',
        'src/main/simple-main.js',
        'src/renderer/index.js',
        'test/electron-builder-config.test.js',
        'scripts/verify-packaged-artifacts.js',
        'CLAUDE.md',
        '.env',
        'webpack.config.js'
      ].forEach((relativePath) =>
        expect([relativePath, packaged(relativePath)]).toEqual([relativePath, false])
      );
    }
  );

  test('no platform block carries its own files list', () => {
    // A string list there becomes the exclude-only matcher described above.
    ['win', 'mac', 'linux'].forEach((platformKey) => {
      expect([platformKey, builderConfig[platformKey].files]).toEqual([platformKey, undefined]);
    });
  });
});

describe('electron-builder.json node_modules exclusions', () => {
  test.each([
    'node_modules/node-llama-cpp/llama/gitRelease.bundle',
    'node_modules/node-llama-cpp/llama/CMakeLists.txt',
    'node_modules/node-llama-cpp/llama/addon/addon.cpp',
    'node_modules/node-llama-cpp/llama/cmake/addVariantSuffix.cmake',
    'node_modules/node-llama-cpp/llama/toolchains/win32.host-x64.target-arm64.cmake',
    'node_modules/node-llama-cpp/templates/packed/electron-typescript-react.json',
    'node_modules/@fugood/whisper.node/whisper.cpp/src/whisper.cpp',
    'node_modules/@fugood/whisper.node/src/WhisperContext.cpp',
    'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
    'node_modules/better-sqlite3/src/better_sqlite3.cpp',
    'node_modules/better-sqlite3/prebuilds/linux-x64.node',
    'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node'
  ])('Windows build leaves out build-only %s', (moduleRelativePath) => {
    expect(isModulePackaged('win', moduleRelativePath)).toBe(false);
  });

  test.each([
    'node_modules/node-llama-cpp/llama/binariesGithubRelease.json',
    'node_modules/node-llama-cpp/llama/grammars/json.gbnf',
    'node_modules/node-llama-cpp/llama/package.json',
    'node_modules/node-llama-cpp/dist/bindings/getLlama.js',
    'node_modules/@node-llama-cpp/win-x64-cuda-ext/bins/win-x64-cuda/fallback/ggml-cuda.dll',
    'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll',
    'node_modules/@fugood/whisper.node/lib/binding.js',
    'node_modules/better-sqlite3/lib/binding.js',
    'node_modules/better-sqlite3/prebuilds/win32-x64.node'
  ])('Windows build keeps runtime file %s', (moduleRelativePath) => {
    expect(isModulePackaged('win', moduleRelativePath)).toBe(true);
  });

  const WIN_ARM64_CONFIG = 'electron-builder.win-arm64.json';
  test.each([
    ['x64', 'node_modules/@node-llama-cpp/win-arm64/bins/win-arm64/llama-addon.node', false],
    ['x64', 'node_modules/@node-llama-cpp/win-arm64/package.json', false],
    ['x64', 'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node', true],
    [
      'x64',
      'node_modules/@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll',
      true
    ],
    ['arm64', 'node_modules/@node-llama-cpp/win-arm64/bins/win-arm64/llama-addon.node', true],
    ['arm64', 'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll', false],
    ['arm64', 'node_modules/node-llama-cpp/dist/bindings/getLlama.js', true]
  ])('Windows %s build packages %s: %s', (arch, moduleRelativePath, expected) => {
    const configFile = arch === 'arm64' ? WIN_ARM64_CONFIG : undefined;
    expect(isModulePackaged('win', moduleRelativePath, arch, configFile)).toBe(expected);
  });

  // lib/binding.js loads prebuilds/<platform>-<arch>.node (linuxmusl-<arch> on
  // musl Linux) and otherwise falls back to build/Release, which is not
  // packaged, so each build must keep exactly its own prebuild.
  const SQLITE_PREBUILDS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'linuxmusl-arm64',
    'linuxmusl-x64',
    'win32-arm64',
    'win32-x64'
  ];
  test.each([
    ['win', 'x64', ['win32-x64']],
    ['win', 'arm64', ['win32-arm64']],
    ['mac', 'x64', ['darwin-x64']],
    ['mac', 'arm64', ['darwin-arm64']],
    ['linux', 'x64', ['linux-x64', 'linuxmusl-x64']],
    ['linux', 'arm64', ['linux-arm64', 'linuxmusl-arm64']]
  ])('%s %s build keeps only its own better-sqlite3 prebuilds', (platformKey, arch, expected) => {
    const configFile = platformKey === 'win' && arch === 'arm64' ? WIN_ARM64_CONFIG : undefined;
    const kept = SQLITE_PREBUILDS.filter((name) =>
      isModulePackaged(
        platformKey,
        `node_modules/better-sqlite3/prebuilds/${name}.node`,
        arch,
        configFile
      )
    );
    expect(kept).toEqual(expected);
    expect(
      isModulePackaged(platformKey, 'node_modules/better-sqlite3/lib/binding.js', arch, configFile)
    ).toBe(true);
  });
});
