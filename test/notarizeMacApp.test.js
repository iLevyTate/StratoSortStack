/**
 * @jest-environment node
 *
 * The afterSign hook replaces electron-builder's one-shot notarization with
 * the same call, retried.
 */

// app-builder-lib loads graceful-fs, which cannot patch the memfs stand-in
// that test-setup.js installs for 'fs'.
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

const path = require('path');
const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper');
const builderConfig = require('../electron-builder.json');
const {
  afterSign,
  getNotarizeOptions,
  loadNotarize,
  notarizeWithRetry
} = require('../scripts/notarize-mac-app');

const APP_PATH = '/out/mac/StratoSort Stack.app';
const NOTARIZE_ENV_KEYS = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE'
];

function silentLog() {
  return { log: jest.fn(), warn: jest.fn() };
}

function macContext(electronPlatformName = 'darwin') {
  return {
    electronPlatformName,
    appOutDir: '/out/mac',
    packager: { appInfo: { productFilename: 'StratoSort Stack' } }
  };
}

describe('electron-builder notarization config', () => {
  test('electron-builder skips its own notarization and runs the retrying hook', () => {
    expect(builderConfig.mac.notarize).toBe(false);
    expect(builderConfig.afterSign).toBe('./scripts/notarize-mac-app.js');
  });

  test('the hook loads the @electron/notarize that electron-builder uses', () => {
    expect(typeof loadNotarize()).toBe('function');
  });
});

describe('getNotarizeOptions matches electron-builder', () => {
  const saved = {};

  beforeEach(() => {
    NOTARIZE_ENV_KEYS.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    NOTARIZE_ENV_KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  function electronBuilderResult() {
    try {
      return { options: MacTargetHelper.getNotarizeOptions(APP_PATH) };
    } catch (error) {
      return { error: error.message };
    }
  }

  function hookResult() {
    try {
      return { options: getNotarizeOptions(APP_PATH, process.env) };
    } catch (error) {
      return { error: error.message };
    }
  }

  test.each([
    ['no credentials', {}],
    ['Apple ID', { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' }],
    ['Apple ID without team', { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'pw' }],
    ['password without Apple ID', { APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' }],
    ['API key', { APPLE_API_KEY: 'k.p8', APPLE_API_KEY_ID: 'KID', APPLE_API_ISSUER: 'ISS' }],
    ['incomplete API key', { APPLE_API_KEY: 'k.p8' }],
    ['keychain profile', { APPLE_KEYCHAIN_PROFILE: 'notary' }],
    ['keychain profile in a keychain', { APPLE_KEYCHAIN_PROFILE: 'notary', APPLE_KEYCHAIN: 'k' }]
  ])('%s', (_label, env) => {
    Object.assign(process.env, env);
    expect(hookResult()).toEqual(electronBuilderResult());
  });
});

describe('notarizeWithRetry', () => {
  const options = { tool: 'notarytool', appPath: APP_PATH };

  test('succeeds on the first attempt without waiting', async () => {
    const notarize = jest.fn().mockResolvedValue(undefined);
    const sleep = jest.fn();

    await expect(notarizeWithRetry(notarize, options, { sleep, log: silentLog() })).resolves.toBe(
      1
    );
    expect(notarize).toHaveBeenCalledWith(options);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('retries a dropped connection and backs off', async () => {
    const offline = new Error(
      'Failed to notarize via notarytool. Failed with unexpected result: \n' +
        'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009'
    );
    const notarize = jest
      .fn()
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const log = silentLog();

    await expect(notarizeWithRetry(notarize, options, { sleep, log })).resolves.toBe(3);
    expect(notarize).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[30000], [60000]]);
    expect(log.warn).toHaveBeenCalledWith(
      '[notarize] Attempt 1 of 3 failed: Failed to notarize via notarytool. Failed with unexpected result: ; retrying in 30 s'
    );
  });

  test('gives up after the last attempt with its error', async () => {
    const notarize = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(notarizeWithRetry(notarize, options, { sleep, log: silentLog() })).rejects.toThrow(
      'third'
    );
    expect(notarize).toHaveBeenCalledTimes(3);
  });
});

describe('afterSign hook', () => {
  const appleIdEnv = {
    APPLE_ID: 'a@b.c',
    APPLE_APP_SPECIFIC_PASSWORD: 'pw',
    APPLE_TEAM_ID: 'TEAM'
  };

  test('notarizes the signed app with the Apple ID credentials', async () => {
    const notarize = jest.fn().mockResolvedValue(undefined);
    const log = silentLog();

    await afterSign(macContext(), { notarize, env: appleIdEnv, log });
    expect(notarize).toHaveBeenCalledWith({
      tool: 'notarytool',
      appPath: path.join('/out/mac', 'StratoSort Stack.app'),
      appleId: 'a@b.c',
      appleIdPassword: 'pw',
      teamId: 'TEAM'
    });
    expect(log.log).toHaveBeenCalledWith('[notarize] StratoSort Stack.app notarized and stapled');
  });

  test.each(['win32', 'linux', 'mas'])('does nothing for %s builds', async (platform) => {
    const notarize = jest.fn();
    await afterSign(macContext(platform), { notarize, env: appleIdEnv, log: silentLog() });
    expect(notarize).not.toHaveBeenCalled();
  });

  test('skips without credentials, as electron-builder did', async () => {
    const notarize = jest.fn();
    const log = silentLog();
    await afterSign(macContext(), { notarize, env: {}, log });
    expect(notarize).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledWith(
      '[notarize] Skipped: no APPLE_ID, APPLE_API_KEY or APPLE_KEYCHAIN_PROFILE credentials'
    );
  });

  test('fails the build when every attempt fails', async () => {
    const notarize = jest
      .fn()
      .mockRejectedValue(new Error('The Internet connection appears to be offline.'));
    await expect(
      afterSign(macContext(), {
        notarize,
        env: appleIdEnv,
        log: silentLog(),
        sleep: jest.fn().mockResolvedValue(undefined)
      })
    ).rejects.toThrow('offline');
    expect(notarize).toHaveBeenCalledTimes(3);
  });
});
