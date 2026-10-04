/**
 * @jest-environment jsdom
 */

import { getElectronAPI, requireElectronAPI } from '../src/renderer/services/ipc/electronApi';

describe('electronApi', () => {
  const originalElectronApi = global.window?.electronAPI;

  afterEach(() => {
    if (global.window) {
      global.window.electronAPI = originalElectronApi;
    }
  });

  test('getElectronAPI returns null when electronAPI is missing', () => {
    if (global.window) {
      delete global.window.electronAPI;
    }
    expect(getElectronAPI()).toBeNull();
  });

  test('getElectronAPI returns window.electronAPI when available', () => {
    global.window.electronAPI = { version: '1.0.0' };
    expect(getElectronAPI()).toEqual({ version: '1.0.0' });
  });

  test('requireElectronAPI throws when missing', () => {
    if (global.window) {
      delete global.window.electronAPI;
    }
    expect(() => requireElectronAPI()).toThrow('Electron API not available');
  });
});
