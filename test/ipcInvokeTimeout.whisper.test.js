/**
 * @jest-environment node
 */
const { IPC_CHANNELS } = require('../src/shared/constants');
const {
  getIpcInvokeTimeout,
  WHISPER_MODEL_INSTALL_INVOKE_TIMEOUT_MS
} = require('../src/shared/ipcInvokeTimeout');

// The whisper model install answers only after the whole download. The 330 s
// default cut off slow links: the banner said the install failed while the
// download carried on and succeeded. Only its 60 s stall timeout ends it.
describe('getIpcInvokeTimeout - whisper model install', () => {
  test('gives the install the longest timer budget', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.WHISPER.INSTALL_MODEL)).toBe(
      WHISPER_MODEL_INSTALL_INVOKE_TIMEOUT_MS
    );
    expect(WHISPER_MODEL_INSTALL_INVOKE_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });

  test('outlasts a 148 MB download at 1 Mbit/s', () => {
    const downloadMs = ((148 * 1024 * 1024 * 8) / 1e6) * 1000;
    expect(getIpcInvokeTimeout(IPC_CHANNELS.WHISPER.INSTALL_MODEL)).toBeGreaterThan(downloadMs);
  });

  test('install status probe keeps the default budget', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.WHISPER.GET_INSTALL_STATUS)).toBe(
      getIpcInvokeTimeout('some:unknown-channel')
    );
  });
});
