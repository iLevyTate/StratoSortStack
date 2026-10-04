'use strict';
const {
  createBodyLimit,
  DEFAULT_MAX_BODY_BYTES
} = require('../../../src/main/transports/mcp/bodyLimit');

describe('bodyLimit', () => {
  const mockRes = () => {
    const r = { statusCode: 200, headers: {}, body: '' };
    r.writeHead = (code, headers) => {
      r.statusCode = code;
      Object.assign(r.headers, headers || {});
    };
    r.end = (b) => {
      r.body = b;
    };
    return r;
  };

  test('exports a 5 MB default cap (documented in docs/MCP_SERVER.md)', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
  });

  test('passes requests with Content-Length within the cap', () => {
    const mw = createBodyLimit();
    const next = jest.fn();
    mw({ headers: { 'content-length': '1024' } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('passes a request exactly at the cap', () => {
    const mw = createBodyLimit();
    const next = jest.fn();
    mw({ headers: { 'content-length': String(DEFAULT_MAX_BODY_BYTES) } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects oversized bodies with 413 and a JSON-RPC error', () => {
    const mw = createBodyLimit();
    const res = mockRes();
    const next = jest.fn();
    mw({ headers: { 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) } }, res, next);
    expect(res.statusCode).toBe(413);
    expect(next).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.body);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error.code).toBe(-32005);
  });

  test.each([undefined, 'not-a-number'])(
    'rejects missing/invalid Content-Length (%p) with 411 — chunked uploads are not supported',
    (value) => {
      const mw = createBodyLimit();
      const res = mockRes();
      const next = jest.fn();
      const headers = value === undefined ? {} : { 'content-length': value };
      mw({ headers }, res, next);
      expect(res.statusCode).toBe(411);
      expect(next).not.toHaveBeenCalled();
    }
  );

  // Streamable HTTP DELETE (session termination) and GET (SSE stream) carry
  // no body and no Content-Length; rejecting them with 411 broke session
  // cleanup for every real client.
  test.each(['GET', 'DELETE'])('passes a body-less %s without Content-Length', (method) => {
    const mw = createBodyLimit();
    const next = jest.fn();
    mw({ method, headers: {} }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('still rejects a chunked DELETE (Transfer-Encoding without Content-Length) with 411', () => {
    const mw = createBodyLimit();
    const res = mockRes();
    const next = jest.fn();
    mw({ method: 'DELETE', headers: { 'transfer-encoding': 'chunked' } }, res, next);
    expect(res.statusCode).toBe(411);
    expect(next).not.toHaveBeenCalled();
  });

  test('still enforces the cap on a DELETE that declares a body', () => {
    const mw = createBodyLimit({ maxBytes: 100 });
    const res = mockRes();
    const next = jest.fn();
    mw({ method: 'DELETE', headers: { 'content-length': '101' } }, res, next);
    expect(res.statusCode).toBe(413);
    expect(next).not.toHaveBeenCalled();
  });

  test('honors a custom maxBytes', () => {
    const mw = createBodyLimit({ maxBytes: 100 });
    const res = mockRes();
    const next = jest.fn();
    mw({ headers: { 'content-length': '101' } }, res, next);
    expect(res.statusCode).toBe(413);
    expect(next).not.toHaveBeenCalled();
  });
});
