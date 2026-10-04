/**
 * @jest-environment node
 */
'use strict';

// Main-process module: needs the Web globals (Response/Headers/URL) that the
// node test environment provides but jsdom does not. `fs` here is the shared
// memfs mock (test-setup.js), which is reset before every test — so all fixtures
// are (re)built in beforeEach, never at module load or in beforeAll.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The shared electron mock (test/mocks/electron.js) has no `protocol`, so we
// replace the module here. registerSchemesAsPrivileged is a spy; `app` is the
// minimum rendererAssets needs (we override getRendererIndexPath below, so
// getAppPath only has to not throw).
const mockRegisterSchemesAsPrivileged = jest.fn();
jest.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: mockRegisterSchemesAsPrivileged },
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}));

// Pin the renderer root to a temp dir we control so the request handler reads
// real (memfs) files through fs.promises.{stat,realpath,readFile}. Keep the rest
// of rendererAssets (isSubPath, resolveRendererAssetPath, content types) real.
let mockRendererRoot;
jest.mock('../../../src/main/core/rendererAssets', () => {
  const actual = jest.requireActual('../../../src/main/core/rendererAssets');
  const nodePath = require('path');
  return {
    ...actual,
    getRendererIndexPath: () => nodePath.join(mockRendererRoot, 'index.html')
  };
});

const {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  APP_INDEX_URL,
  registerAppProtocolHandler
} = require('../../../src/main/core/appProtocol');

function makeSession() {
  let captured = null;
  const handle = jest.fn((_scheme, fn) => {
    captured = fn;
  });
  return { session: { protocol: { handle } }, getHandler: () => captured, handle };
}

describe('appProtocol', () => {
  // memfs is reset before every test; rebuild the bundle fixture each time.
  beforeEach(() => {
    mockRendererRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appproto-')));
    fs.mkdirSync(path.join(mockRendererRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(mockRendererRoot, 'index.html'), '<html>shell</html>');
    fs.writeFileSync(path.join(mockRendererRoot, 'assets', 'app.js'), 'console.log(1)');

    // Symlink that escapes the bundle root — exercises the realpath containment
    // re-check. memfs supports symlinks, so this runs everywhere.
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appproto-out-')));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(mockRendererRoot, 'leak.txt'));
  });

  describe('exported constants', () => {
    test('scheme/host/origin/index URL are internally consistent', () => {
      expect(APP_SCHEME).toBe('app');
      expect(APP_HOST).toBe('bundle');
      expect(APP_ORIGIN).toBe('app://bundle');
      expect(APP_INDEX_URL).toBe('app://bundle/index.html');
    });
  });

  describe('registerAppSchemePrivileged', () => {
    beforeEach(() => mockRegisterSchemesAsPrivileged.mockClear());

    test('registers the app scheme with the standard+secure+fetch+codeCache+stream privilege set', () => {
      jest.isolateModules(() => {
        require('../../../src/main/core/appProtocol').registerAppSchemePrivileged();
      });
      expect(mockRegisterSchemesAsPrivileged).toHaveBeenCalledTimes(1);
      const [schemes] = mockRegisterSchemesAsPrivileged.mock.calls[0];
      expect(schemes).toEqual([
        {
          scheme: 'app',
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            codeCache: true,
            stream: true
          }
        }
      ]);
    });

    test('is memoized — repeated calls on the same module instance are a no-op', () => {
      jest.isolateModules(() => {
        const { registerAppSchemePrivileged } = require('../../../src/main/core/appProtocol');
        registerAppSchemePrivileged();
        registerAppSchemePrivileged();
        registerAppSchemePrivileged();
      });
      expect(mockRegisterSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerAppProtocolHandler — registration guards', () => {
    test('does nothing when session is missing', () => {
      expect(() => registerAppProtocolHandler(null)).not.toThrow();
    });

    test('does nothing when session.protocol.handle is not a function', () => {
      expect(() => registerAppProtocolHandler({ protocol: {} })).not.toThrow();
      expect(() => registerAppProtocolHandler({})).not.toThrow();
    });

    test('registers the handler once per session (idempotent via WeakSet)', () => {
      const { session, handle } = makeSession();
      registerAppProtocolHandler(session);
      registerAppProtocolHandler(session);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(APP_SCHEME, expect.any(Function));
    });
  });

  describe('registerAppProtocolHandler — request handling', () => {
    let handler;

    beforeEach(() => {
      const { session, getHandler } = makeSession();
      registerAppProtocolHandler(session);
      handler = getHandler();
    });

    const call = (url) => handler({ url });

    test('serves a nested asset with 200 + correct content-type', async () => {
      const res = await call('app://bundle/assets/app.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(await res.text()).toBe('console.log(1)');
    });

    test('attaches the locked-down security headers to served assets', async () => {
      const res = await call('app://bundle/assets/app.js');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    test('maps the root path to index.html (200)', async () => {
      const res = await call('app://bundle/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>shell</html>');
    });

    test('falls back to the app shell for extensionless SPA deep links (200)', async () => {
      const res = await call('app://bundle/discover/deep/route');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>shell</html>');
    });

    test('returns 404 when the host is not the bundle host', async () => {
      const res = await call('app://evil/index.html');
      expect(res.status).toBe(404);
    });

    test('returns 404 for a missing file that has an extension', async () => {
      const res = await call('app://bundle/assets/missing.js');
      expect(res.status).toBe(404);
    });

    test('returns 500 when the request URL is malformed', async () => {
      const res = await call('::::not-a-url');
      expect(res.status).toBe(500);
    });

    test('returns 403 when a symlink under the root resolves outside it', async () => {
      const res = await call('app://bundle/leak.txt');
      expect(res.status).toBe(403);
    });
  });
});
