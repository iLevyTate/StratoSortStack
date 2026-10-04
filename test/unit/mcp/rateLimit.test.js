'use strict';
const { createRateLimit } = require('../../../src/main/transports/mcp/rateLimit');

describe('rateLimit', () => {
  const mockRes = () => ({
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(c, h) {
      this.statusCode = c;
      if (h) Object.assign(this.headers, h);
    },
    end(b) {
      this.body = b;
    }
  });

  const request = (sessionId, remoteAddress = '127.0.0.1') => ({
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    socket: { remoteAddress }
  });

  // Freeze the clock so the bucket cannot refill between calls.
  let nowSpy;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  test('allows under the limit', () => {
    const mw = createRateLimit({ limitPerMin: 60 });
    const next = jest.fn();
    for (let i = 0; i < 60; i++) mw(request('s1'), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(60);
  });

  test('rejects with 429 when over the limit', () => {
    const mw = createRateLimit({ limitPerMin: 5 });
    const next = jest.fn();
    const responses = [];
    for (let i = 0; i < 7; i++) {
      const res = mockRes();
      responses.push(res);
      mw(request('s1'), res, next);
    }
    expect(next).toHaveBeenCalledTimes(5);
    expect(responses[5].statusCode).toBe(429);
    expect(responses[5].headers['Retry-After']).toBeDefined();
  });

  test('the 61st request for one session id is 429 at limitPerMin 60', () => {
    const mw = createRateLimit({ limitPerMin: 60 });
    const next = jest.fn();
    for (let i = 0; i < 60; i++) mw(request('s1'), mockRes(), next);
    const res = mockRes();
    mw(request('s1'), res, next);
    expect(next).toHaveBeenCalledTimes(60);
    expect(res.statusCode).toBe(429);
  });

  test('different session ids get independent buckets', () => {
    const mw = createRateLimit({ limitPerMin: 2 });
    const next = jest.fn();
    mw(request('a'), mockRes(), next);
    mw(request('a'), mockRes(), next);
    const limited = mockRes();
    mw(request('a'), limited, next);
    expect(limited.statusCode).toBe(429);

    const other = mockRes();
    mw(request('b'), other, next);
    expect(other.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(3);
  });

  test('header-less requests share one init bucket regardless of Authorization', () => {
    const mw = createRateLimit({ limitPerMin: 2 });
    const next = jest.fn();
    const withAuth = (value) => ({
      headers: { authorization: `Bearer ${value}` },
      socket: { remoteAddress: '127.0.0.1' }
    });
    mw(withAuth('one'), mockRes(), next);
    mw(withAuth('two'), mockRes(), next);
    const limited = mockRes();
    mw(withAuth('three'), limited, next);
    expect(limited.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
