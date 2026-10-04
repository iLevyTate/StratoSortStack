/**
 * Verifies the ipcSenderValidator rejection path operates correctly when the
 * test bypass is OFF — proving the validator is the active guardrail in
 * production, not just a code path that's always short-circuited.
 *
 * The whole-suite test-setup.js calls setTestBypass(true) so existing tests
 * keep passing. These tests explicitly flip it off in beforeEach and restore
 * it in afterEach.
 */

const { app } = require('electron');
const {
  assertAllowedIpcSender,
  isAllowedRendererUrl,
  setTestBypass,
  setDevPermissive
} = require('../src/main/ipc/ipcSenderValidator');

function withPackagedApp(fn) {
  const original = app.isPackaged;
  app.isPackaged = true;
  try {
    fn();
  } finally {
    app.isPackaged = original;
  }
}

describe('ipcSenderValidator — strict mode (bypass disabled)', () => {
  beforeEach(() => {
    setTestBypass(false);
    setDevPermissive(false);
  });

  afterEach(() => {
    // Restore the suite-wide default so subsequent tests run unaffected.
    setTestBypass(true);
    setDevPermissive(false);
  });

  describe('allowlist', () => {
    test.each([
      ['app://renderer/index.html'],
      ['file:///tmp/index.html'],
      ['http://127.0.0.1:3000/'],
      ['http://localhost:3000/']
    ])('accepts %s', (url) => {
      expect(isAllowedRendererUrl(url)).toBe(true);
    });

    test.each([
      ['https://evil.example.com/'],
      ['data:text/html,<script>alert(1)</script>'],
      ['javascript:alert(1)'],
      ['chrome://settings/'],
      ['']
    ])('rejects %s', (url) => {
      expect(isAllowedRendererUrl(url)).toBe(false);
    });
  });

  describe('assertAllowedIpcSender', () => {
    function makeEvent(url) {
      return {
        senderFrame: { url },
        sender: { getURL: () => url }
      };
    }

    test('returns null for allowed app:// origin', () => {
      const result = assertAllowedIpcSender(makeEvent('app://renderer/index.html'), 'test:channel');
      expect(result).toBeNull();
    });

    test('returns rejection envelope for unknown https origin', () => {
      const result = assertAllowedIpcSender(makeEvent('https://attacker.example/'), 'test:channel');
      expect(result).toEqual({
        success: false,
        error: {
          code: 'IPC_SENDER_REJECTED',
          message: 'Invalid or unknown sender origin'
        }
      });
    });

    test('returns rejection envelope for data: URL', () => {
      const result = assertAllowedIpcSender(
        makeEvent('data:text/html,<script>alert(1)</script>'),
        'test:channel'
      );
      expect(result).not.toBeNull();
      expect(result.error.code).toBe('IPC_SENDER_REJECTED');
    });

    test('rejects missing sender URL when dev-permissive is OFF', () => {
      const event = { senderFrame: { url: '' }, sender: { getURL: () => '' } };
      const result = assertAllowedIpcSender(event, 'test:channel');
      expect(result).not.toBeNull();
      expect(result.error.code).toBe('IPC_SENDER_REJECTED');
    });

    test('accepts missing sender URL when dev-permissive is ON', () => {
      setDevPermissive(true);
      const event = { senderFrame: { url: '' }, sender: { getURL: () => '' } };
      const result = assertAllowedIpcSender(event, 'test:channel');
      expect(result).toBeNull();
    });

    test('ignores dev-permissive for missing sender URL in a packaged app', () => {
      withPackagedApp(() => {
        setDevPermissive(true);
        const event = { senderFrame: { url: '' }, sender: { getURL: () => '' } };
        const result = assertAllowedIpcSender(event, 'test:channel');
        expect(result).not.toBeNull();
        expect(result.error.code).toBe('IPC_SENDER_REJECTED');
      });
    });

    test('still rejects bad URL even when dev-permissive is ON', () => {
      setDevPermissive(true);
      const result = assertAllowedIpcSender(makeEvent('https://attacker.example/'), 'test:channel');
      expect(result).not.toBeNull();
      expect(result.error.code).toBe('IPC_SENDER_REJECTED');
    });

    test('handles destroyed sender (getURL throws)', () => {
      const event = {
        senderFrame: undefined,
        sender: {
          getURL: () => {
            throw new Error('webContents destroyed');
          }
        }
      };
      const result = assertAllowedIpcSender(event, 'test:channel');
      // No URL resolvable, dev-permissive off → rejected
      expect(result).not.toBeNull();
      expect(result.error.code).toBe('IPC_SENDER_REJECTED');
    });

    test('prefers senderFrame.url over sender.getURL()', () => {
      const event = {
        senderFrame: { url: 'app://renderer/index.html' },
        sender: { getURL: () => 'https://attacker.example/' }
      };
      const result = assertAllowedIpcSender(event, 'test:channel');
      expect(result).toBeNull();
    });
  });

  describe('bypass setter contract', () => {
    test('setTestBypass(true) is ignored in a packaged app', () => {
      withPackagedApp(() => {
        setTestBypass(true);
        const event = { senderFrame: { url: 'https://attacker.example/' } };
        expect(assertAllowedIpcSender(event, 'test:channel')).not.toBeNull();
      });
    });

    test('setTestBypass(true) short-circuits even a malicious origin', () => {
      setTestBypass(true);
      const event = { senderFrame: { url: 'https://attacker.example/' } };
      expect(assertAllowedIpcSender(event, 'test:channel')).toBeNull();
    });

    test('setTestBypass(false) re-enables strict checks', () => {
      setTestBypass(true);
      setTestBypass(false);
      const event = { senderFrame: { url: 'https://attacker.example/' } };
      expect(assertAllowedIpcSender(event, 'test:channel')).not.toBeNull();
    });
  });
});
