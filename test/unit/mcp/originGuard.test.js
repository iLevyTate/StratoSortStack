'use strict';
const { createOriginGuard } = require('../../../src/main/transports/mcp/originGuard');

describe('originGuard', () => {
  const mw = createOriginGuard();
  const mockRes = () => {
    const r = { statusCode: 200, headers: {}, body: '' };
    r.setHeader = (k, v) => {
      r.headers[k] = v;
    };
    r.writeHead = (code) => {
      r.statusCode = code;
    };
    r.end = (b) => {
      r.body = b;
    };
    return r;
  };

  test('allows missing Origin', () => {
    const next = jest.fn();
    mw({ headers: {} }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects literal "null" Origin (sandboxed iframes, file://, redirects)', () => {
    // Browsers send Origin: null for sandboxed iframes, file:// pages, and
    // redirected requests. Legit MCP clients never produce a literal-null
    // origin; only browser contexts do.
    const res = mockRes();
    const next = jest.fn();
    mw({ headers: { origin: 'null' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test.each(['claude://desktop', 'cursor://app', 'zed://workspace', 'vscode-webview://abc'])(
    'allows native origin %s',
    (origin) => {
      const next = jest.fn();
      mw({ headers: { origin } }, mockRes(), next);
      expect(next).toHaveBeenCalled();
    }
  );

  test.each(['http://evil.example.com', 'https://example.com'])(
    'rejects browser origin %s with 403',
    (origin) => {
      const res = mockRes();
      const next = jest.fn();
      mw({ headers: { origin } }, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  );

  test.each([
    'file:///etc/passwd',
    'data:text/html,<script>fetch("http://127.0.0.1:53827/mcp")</script>',
    'chrome-extension://maliciousid',
    'electron://app',
    'tauri://localhost',
    'app://internal'
  ])('deny-by-default rejects non-allowlisted scheme %s with 403', (origin) => {
    // The pre-fix guard let anything that wasn't http(s) through, including
    // file://, chrome-extension://, data:, etc. Verify the deny-by-default
    // surface holds.
    const res = mockRes();
    const next = jest.fn();
    mw({ headers: { origin } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
