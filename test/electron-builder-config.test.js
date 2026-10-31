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

// Runs app-builder-lib's own node_modules filter (the one NodeModuleCopyHelper
// applies while copying dependencies) against the committed `files` patterns.
describe('electron-builder.json node_modules exclusions', () => {
  const { getNodeModuleFileMatcher, FileMatcher } = require('app-builder-lib/out/fileMatcher');

  function isPackaged(platformKey, moduleRelativePath, arch = 'x64') {
    const packager = { config: builderConfig, debugLogger: { isEnabled: false } };
    // app-builder-lib expands ${arch} in `files` patterns per packed arch.
    const macroExpander = (pattern) => pattern.replace(/\$\{arch\}/g, arch);
    const nodeModuleMatcher = getNodeModuleFileMatcher(
      '/project',
      '/out/app',
      macroExpander,
      builderConfig[platformKey] || {},
      packager
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
    expect(isPackaged('win', moduleRelativePath)).toBe(false);
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
    expect(isPackaged('win', moduleRelativePath)).toBe(true);
  });

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
    expect(isPackaged('win', moduleRelativePath, arch)).toBe(expected);
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
    const kept = SQLITE_PREBUILDS.filter((name) =>
      isPackaged(platformKey, `node_modules/better-sqlite3/prebuilds/${name}.node`, arch)
    );
    expect(kept).toEqual(expected);
    expect(isPackaged(platformKey, 'node_modules/better-sqlite3/lib/binding.js', arch)).toBe(true);
  });
});
