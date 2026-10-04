// @ts-check
'use strict';

// HTTP request body size guard. The MCP SDK's StreamableHTTPServerTransport
// buffers the full request body before JSON-parsing it, so an unbounded
// client could pin memory with a multi-GB POST. docs/MCP_SERVER.md documents
// a 5 MB payload guard — this middleware is that guard.
//
// Implementation note: we deliberately gate on the Content-Length header
// rather than counting streamed bytes. Node's HTTP parser enforces that the
// body matches the declared Content-Length (excess bytes become a parse
// error on the connection), so the header cannot understate the body size.
// Chunked uploads carry no length up front and would require attaching a
// 'data' listener that races the SDK's own stream consumption — instead we
// reject them outright (no MCP client sends chunked JSON-RPC posts).
//
// Streamable HTTP also uses body-less GET (SSE notification stream) and
// DELETE (session termination); clients send neither Content-Length nor
// Transfer-Encoding on those, so they pass without a length check.
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const BODYLESS_METHODS = new Set(['GET', 'DELETE', 'HEAD', 'OPTIONS']);

function _reject(/** @type {any} */ res, /** @type {any} */ status, /** @type {any} */ message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32005, message } }));
}

function createBodyLimit({ maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return function bodyLimit(
    /** @type {any} */ req,
    /** @type {any} */ res,
    /** @type {any} */ next
  ) {
    const rawLength = req.headers['content-length'];
    if (
      rawLength === undefined &&
      req.headers['transfer-encoding'] === undefined &&
      BODYLESS_METHODS.has(req.method)
    ) {
      next();
      return;
    }
    const declared = Number(rawLength);
    if (!Number.isFinite(declared)) {
      _reject(res, 411, 'Content-Length required');
      return;
    }
    if (declared > maxBytes) {
      _reject(res, 413, 'Request body too large');
      return;
    }
    next();
  };
}

module.exports = { createBodyLimit, DEFAULT_MAX_BODY_BYTES };
