/**
 * Regression tests for electron-builder.json security configuration.
 * Validates that packaging config values remain safe across changes.
 */

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
