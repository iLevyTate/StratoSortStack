/**
 * @jest-environment node
 *
 * `<appData>/Electron` is Electron's default userData folder for ANY
 * unpackaged Electron app, not a StratoSort name. Legacy-profile discovery may
 * only use it when it holds StratoSort's own state, otherwise another app's
 * settings.json / window-state.json (or its models) would be imported into a
 * fresh StratoSort profile.
 *
 * Real filesystem in a temp dir.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockUserDataPath = '';
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserDataPath) }
}));

jest.mock('../src/shared/logger', () => {
  const logger = { setContext: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  migrateUserDataState,
  getLegacyUserDataPaths
} = require('../src/main/core/userDataMigration');

describe('legacy userData discovery and the shared Electron folder', () => {
  let appData;
  let sharedElectron;

  const write = (filePath, value) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  };

  beforeEach(() => {
    appData = fs.mkdtempSync(
      path.join(jest.requireActual('os').tmpdir(), 'stratosort-userdata-migration-')
    );
    mockUserDataPath = path.join(appData, 'StratoSort Stack');
    fs.mkdirSync(mockUserDataPath, { recursive: true });
    sharedElectron = path.join(appData, 'Electron');
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  test("another app's files in the shared Electron folder are not imported", async () => {
    write(path.join(sharedElectron, 'window-state.json'), { x: 5000, y: 5000, width: 400 });
    write(path.join(sharedElectron, 'settings.json'), { someOtherAppKey: true });
    write(path.join(sharedElectron, 'models', 'other-app.gguf'), 'gguf');

    expect(getLegacyUserDataPaths()).not.toContain(path.resolve(sharedElectron));

    const results = await migrateUserDataState();

    expect(results.migrated).toEqual([]);
    expect(fs.existsSync(path.join(mockUserDataPath, 'window-state.json'))).toBe(false);
    expect(fs.existsSync(path.join(mockUserDataPath, 'settings.json'))).toBe(false);
  });

  test('a StratoSort profile in the Electron folder is still migrated', async () => {
    write(path.join(sharedElectron, 'analysis-history.json'), { entries: {} });
    write(path.join(sharedElectron, 'settings.json'), { experienceMode: 'simple' });

    expect(getLegacyUserDataPaths()).toContain(path.resolve(sharedElectron));

    const results = await migrateUserDataState();

    expect(results.migrated.map((entry) => entry.file).sort()).toEqual([
      'analysis-history.json',
      'settings.json'
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(mockUserDataPath, 'settings.json'), 'utf8'))
    ).toEqual({ experienceMode: 'simple' });
  });

  test('StratoSort-named legacy folders need no marker', () => {
    write(path.join(appData, 'StratoSort Core', 'settings.json'), { experienceMode: 'simple' });

    expect(getLegacyUserDataPaths()).toContain(path.resolve(appData, 'StratoSort Core'));
  });
});
