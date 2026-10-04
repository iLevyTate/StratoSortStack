/**
 * Smoke tests for the centralized Electron mock so new tests can import it
 * instead of inlining Menu/Tray/safeStorage stubs.
 */

describe('test/mocks/electron', () => {
  const electron = require('./electron');

  test('exports the APIs previously inlined by individual suites', () => {
    expect(electron.Menu.buildFromTemplate).toEqual(expect.any(Function));
    expect(electron.Notification).toEqual(expect.any(Function));
    expect(electron.Tray).toEqual(expect.any(Function));
    expect(electron.contextBridge.exposeInMainWorld).toEqual(expect.any(Function));
    expect(electron.crashReporter.start).toEqual(expect.any(Function));
    expect(electron.globalShortcut.register).toEqual(expect.any(Function));
    expect(electron.nativeImage.createFromPath).toEqual(expect.any(Function));
    expect(electron.protocol.registerFileProtocol).toEqual(expect.any(Function));
    expect(electron.safeStorage.isEncryptionAvailable()).toBe(false);
    expect(electron.webUtils.getPathForFile({ path: 'C:\\a.txt' })).toBe('C:\\a.txt');
  });

  test('reuses the same singleton across require() after resetModules', () => {
    const first = require('./electron');
    jest.resetModules();
    const second = require('./electron');
    expect(second.ipcMain).toBe(first.ipcMain);
    expect(second.Menu).toBe(first.Menu);
  });
});
