'use strict';
const { createAuthMiddleware } = require('../../../src/main/transports/mcp/auth');

describe('auth middleware', () => {
  const TOKEN = 'a'.repeat(64);
  const mw = createAuthMiddleware(() => TOKEN);
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

  test('rejects missing Authorization header (401)', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects wrong token (401)', () => {
    const req = { headers: { authorization: `Bearer ${'b'.repeat(64)}` } };
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts correct token', () => {
    const req = { headers: { authorization: `Bearer ${TOKEN}` } };
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects token of wrong length without timing leak', () => {
    const req = { headers: { authorization: 'Bearer short' } };
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  test('rejects oversized Authorization header before any work', () => {
    // Without the 1KiB cap, an unauthenticated caller could force large
    // Buffer allocations on every request.
    const huge = 'B'.repeat(2048);
    const req = { headers: { authorization: `Bearer ${huge}` } };
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('does not accept empty token even if expected is empty (defense in depth)', () => {
    const emptyTokenMw = createAuthMiddleware(() => '');
    const req = { headers: { authorization: 'Bearer ' } };
    const res = mockRes();
    const next = jest.fn();
    emptyTokenMw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
