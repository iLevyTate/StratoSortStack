// @ts-check
'use strict';
const http = require('node:http');

/**
 * @param {{ requestHandler: http.RequestListener, port?: number, logger?: any }} args
 */
async function createTransport({ requestHandler, port = 53827, logger = null }) {
  const server = http.createServer(requestHandler);
  let preferredPortInUse = false;
  await new Promise((resolve, reject) => {
    const onError = (/** @type {any} */ err) => {
      if (err.code === 'EADDRINUSE') {
        // Fall back to an OS-assigned ephemeral port. Log it so a user
        // diagnosing "my MCP client can't reach the server" can correlate the
        // configured port with the actual one. The lifecycle service emits
        // status-changed with the real port, but a startup log entry helps
        // debugging without a renderer attached.
        preferredPortInUse = true;
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => resolve(undefined));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
  if (preferredPortInUse && logger?.warn) {
    logger.warn('[mcp] preferred port unavailable; bound to ephemeral port', {
      requestedPort: port,
      actualPort
    });
  }
  return {
    server,
    port: actualPort,
    // server.close() alone only stops accepting; it waits for every open
    // connection (e.g. a client parked on an SSE stream) to end on its own.
    close: () => {
      server.closeAllConnections();
      return new Promise((res) => server.close(() => res()));
    }
  };
}

module.exports = { createTransport };
