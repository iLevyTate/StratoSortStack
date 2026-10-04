'use strict';
const http = require('node:http');
const { createTransport } = require('../../../src/main/transports/mcp/transport');

describe('transport', () => {
  test('binds to 127.0.0.1 only', async () => {
    const handler = (req, res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const t = await createTransport({ requestHandler: handler, port: 0 });
    const addr = t.server.address();
    expect(addr.address).toBe('127.0.0.1');
    expect(typeof addr.port).toBe('number');
    await t.close();
  });

  test('close() resolves while a client still holds an open response', async () => {
    const t = await createTransport({
      requestHandler: (_, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
      },
      port: 0
    });
    const res = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: t.port, path: '/' }, resolve);
      req.on('error', () => {});
    });
    res.on('error', () => {});
    res.resume();

    const startedAt = Date.now();
    await t.close();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  }, 3000);

  test('next-free-port fallback when preferred port is in use', async () => {
    const blocker = http.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const blocked = blocker.address().port;
    const t = await createTransport({ requestHandler: (_, res) => res.end(), port: blocked });
    expect(t.server.address().port).not.toBe(blocked);
    await t.close();
    blocker.close();
  });
});
