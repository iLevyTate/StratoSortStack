/**
 * @jest-environment node
 *
 * The Playwright helper gives every launch an isolated, empty userData dir.
 * An empty profile has no models, so the app's background setup would start a
 * real multi-GB model download on every E2E launch. Helper-created profiles
 * must carry the "Continue with limited AI" consent (modelAutoDownloadSkipped)
 * so E2E runs stay deterministic and network-free, with an explicit opt-out
 * for specs that exercise the download path.
 *
 * Runs on the real filesystem in a temp dir: the helper writes real files the
 * Electron child process reads.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs');
const path = require('path');
const playwright = require('@playwright/test');

const {
  launchApp,
  dismissModelSetupWizard,
  openModelSetupWizardOffline,
  BACKGROUND_DOWNLOAD_DECLINED_LOG,
  createIsolatedE2eUserDataDir,
  cleanupE2eUserDataDir
} = require('./e2e/helpers/electronApp');
const { validateSettings } = require('../src/shared/settingsValidation');

function readSettings(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
}

function fakeElectronApp() {
  const window = {
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
    waitForSelector: jest.fn().mockResolvedValue(undefined)
  };
  return {
    process: () => null,
    firstWindow: jest.fn().mockResolvedValue(window)
  };
}

describe('E2E isolated profile seeding', () => {
  const created = [];
  let launchSpy;

  beforeEach(() => {
    launchSpy = jest.spyOn(playwright._electron, 'launch');
  });

  afterEach(() => {
    launchSpy.mockRestore();
    while (created.length) cleanupE2eUserDataDir(created.pop());
  });

  test('a helper-created profile declines background model downloads', () => {
    const dir = createIsolatedE2eUserDataDir();
    created.push(dir);

    expect(readSettings(dir)).toEqual({ modelAutoDownloadSkipped: true });
  });

  test('the seeded settings pass the app settings validation', () => {
    const dir = createIsolatedE2eUserDataDir();
    created.push(dir);

    const result = validateSettings(readSettings(dir));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('specs that exercise downloads can opt out of the seed', () => {
    const dir = createIsolatedE2eUserDataDir({ allowModelAutoDownload: true });
    created.push(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });

  test('launchApp hands the app a seeded profile by default', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());

    const { e2eUserData } = await launchApp();
    created.push(e2eUserData);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0].env.STRATOSORT_E2E_USER_DATA).toBe(e2eUserData);
    expect(readSettings(e2eUserData)).toEqual({ modelAutoDownloadSkipped: true });
  });

  test('launchApp({ allowModelAutoDownload: true }) leaves the profile empty', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());

    const { e2eUserData } = await launchApp({ allowModelAutoDownload: true });
    created.push(e2eUserData);

    expect(fs.existsSync(path.join(e2eUserData, 'settings.json'))).toBe(false);
  });

  test('a spec-provided profile is never rewritten', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());
    const dir = createIsolatedE2eUserDataDir({ allowModelAutoDownload: true });
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ experienceMode: 'simple' }));

    await launchApp({ userDataDir: dir });

    expect(readSettings(dir)).toEqual({ experienceMode: 'simple' });
  });

  test('a seeded launch does not wait for a model wizard that cannot open', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());
    const { window, e2eUserData } = await launchApp();
    created.push(e2eUserData);
    window.locator = jest.fn(() => {
      throw new Error('should not look for the wizard');
    });

    await expect(dismissModelSetupWizard(window)).resolves.toBe(false);
    expect(window.locator).not.toHaveBeenCalled();
  });

  test('an unseeded launch still looks for the model wizard', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());
    const { window, e2eUserData } = await launchApp({ allowModelAutoDownload: true });
    created.push(e2eUserData);
    const waitFor = jest.fn().mockRejectedValue(new Error('timeout'));
    window.locator = jest.fn(() => ({ filter: () => ({ first: () => ({ waitFor }) }) }));

    await expect(dismissModelSetupWizard(window, { timeout: 1 })).resolves.toBe(false);
    expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1 });
  });
});

describe('openModelSetupWizardOffline', () => {
  // The axe audit needs the first-run wizard, which only auto-opens on a
  // profile without the limited-AI choice. That same profile makes background
  // setup download models, so the helper must only clear the choice after
  // background setup has already declined on the seeded profile.
  const created = [];
  let launchSpy;
  let originalWindow;

  beforeEach(() => {
    launchSpy = jest.spyOn(playwright._electron, 'launch');
    originalWindow = global.window;
  });

  afterEach(() => {
    launchSpy.mockRestore();
    global.window = originalWindow;
    while (created.length) cleanupE2eUserDataDir(created.pop());
  });

  function writeSessionLog(userDataDir, text) {
    fs.mkdirSync(path.join(userDataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'logs', 'stratosort-test.log'), text);
  }

  function fakeRenderer(page, calls) {
    const update = jest.fn(async (key, value) => {
      calls.push(['settings.update', key, value]);
    });
    global.window = { electronAPI: { settings: { update } } };
    // Like Playwright: the function is serialized and runs against the
    // renderer's global window, not the caller's closure.
    page.evaluate = jest.fn(async (fn) => new Function(`return (${fn.toString()})()`)());
    page.reload = jest.fn(async () => {
      calls.push(['reload']);
    });
    return update;
  }

  test('refuses an unseeded profile, where background setup downloads', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());
    const { app, window, e2eUserData } = await launchApp({ allowModelAutoDownload: true });
    created.push(e2eUserData);
    const calls = [];
    const update = fakeRenderer(window, calls);

    await expect(openModelSetupWizardOffline(app, window, { timeout: 50 })).rejects.toThrow(
      /seeded with modelAutoDownloadSkipped/
    );
    expect(update).not.toHaveBeenCalled();
    expect(window.reload).not.toHaveBeenCalled();
  });

  test('clears the choice only after background setup declined, then reloads', async () => {
    const electronApp = fakeElectronApp();
    launchSpy.mockResolvedValue(electronApp);
    const { app, window, e2eUserData } = await launchApp();
    created.push(e2eUserData);
    app.__e2eUserData = e2eUserData;
    const calls = [];
    fakeRenderer(window, calls);

    const opening = openModelSetupWizardOffline(app, window, { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toEqual([]);

    writeSessionLog(e2eUserData, `{"msg":"[BACKGROUND] ${BACKGROUND_DOWNLOAD_DECLINED_LOG}"}`);
    await opening;

    expect(calls).toEqual([['settings.update', 'modelAutoDownloadSkipped', false], ['reload']]);
  });

  test('fails instead of clearing the choice when background setup never declined', async () => {
    launchSpy.mockResolvedValue(fakeElectronApp());
    const { app, window, e2eUserData } = await launchApp();
    created.push(e2eUserData);
    app.__e2eUserData = e2eUserData;
    const calls = [];
    fakeRenderer(window, calls);

    await expect(openModelSetupWizardOffline(app, window, { timeout: 300 })).rejects.toThrow(
      /did not log/
    );
    expect(calls).toEqual([]);
  });
});

describe('E2E specs stay network-free', () => {
  const E2E_DIR = path.join(__dirname, 'e2e');
  // Specs live in per-area subfolders (test/e2e/<area>/*.spec.js), so scan recursively.
  const specSources = fs
    .readdirSync(E2E_DIR, { recursive: true })
    .map((name) => String(name).replace(/\\/g, '/'))
    .filter((name) => name.endsWith('.spec.js'))
    .sort()
    .map((name) => [name, fs.readFileSync(path.join(E2E_DIR, name), 'utf8')]);

  // A spec auditing the wizard used to launch with allowModelAutoDownload,
  // which starts a real multi-GB model download in background setup.
  const WAITS_FOR_WIZARD = /getByRole\(\s*'dialog',\s*\{\s*name:\s*\/set up on-device ai\/i/;
  const wizardSpecs = specSources.filter(([, source]) => WAITS_FOR_WIZARD.test(source));

  test('at least one spec audits the wizard (guards the scan itself)', () => {
    expect(wizardSpecs.length).toBeGreaterThan(0);
  });

  test.each(wizardSpecs)('%s opens the wizard through the offline helper', (name, source) => {
    expect(source).toMatch(/openModelSetupWizardOffline\(/);
  });

  test.each(specSources)('%s never opts out of the limited-AI seed', (name, source) => {
    expect(source).not.toMatch(/allowModelAutoDownload/);
  });

  // A spec-provided userDataDir is used as-is, so it must come from the
  // seeding helper; a bare fs.mkdtemp profile is empty and downloads models.
  const ownProfileSpecs = specSources.filter(([, source]) =>
    /launchApp\(\s*\{[^}]*userDataDir/.test(source)
  );

  test('at least one spec reuses its own profile (guards the scan itself)', () => {
    expect(ownProfileSpecs.length).toBeGreaterThan(0);
  });

  test.each(ownProfileSpecs)('%s seeds the profile it passes to launchApp', (name, source) => {
    expect(source).toMatch(/createIsolatedE2eUserDataDir\(/);
  });
});
