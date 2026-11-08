/**
 * A packaged build only ever serves its renderer from app://. The dev
 * origins (local HTTP server, file:// fallback) must not pass the IPC sender
 * gate there; in unpackaged dev/test runs they keep working.
 */
const { app } = require('electron');
const {
  assertAllowedIpcSender,
  isAllowedRendererUrl,
  setTestBypass,
  setDevPermissive
} = require('../src/main/ipc/ipcSenderValidator');

const DEV_ORIGINS = [
  'http://localhost:3000/',
  'http://127.0.0.1:51234/index.html',
  'file:///C:/x.html'
];

describe('ipcSenderValidator origins by build type', () => {
  let originalPackaged;

  beforeEach(() => {
    originalPackaged = app.isPackaged;
    setTestBypass(false);
    setDevPermissive(false);
  });

  afterEach(() => {
    app.isPackaged = originalPackaged;
    setTestBypass(true);
    setDevPermissive(false);
  });

  describe('packaged', () => {
    beforeEach(() => {
      app.isPackaged = true;
    });

    test.each(DEV_ORIGINS)('rejects dev origin %s', (url) => {
      expect(isAllowedRendererUrl(url)).toBe(false);
      const result = assertAllowedIpcSender(
        /** @type {any} */ ({ senderFrame: { url }, sender: { getURL: () => url } }),
        'files:delete'
      );
      expect(result?.error?.code).toBe('IPC_SENDER_REJECTED');
    });

    test('accepts the app:// renderer', () => {
      expect(isAllowedRendererUrl('app://bundle/index.html')).toBe(true);
    });
  });

  describe('unpackaged (dev / tests)', () => {
    beforeEach(() => {
      app.isPackaged = false;
    });

    test.each([...DEV_ORIGINS, 'app://bundle/index.html'])('accepts %s', (url) => {
      expect(isAllowedRendererUrl(url)).toBe(true);
    });
  });
});
