// @ts-check
'use strict';
const crypto = require('node:crypto');

// Hard cap on the Authorization header — bigger values are rejected before
// any Buffer allocation. 1KiB is far above any legitimate bearer token size.
const MAX_AUTH_VALUE_BYTES = 1024;

function createAuthMiddleware(/** @type {any} */ getToken) {
  // Cache the expected token's sha256 digest so we don't recompute it per
  // request. The token only changes on rotateToken, so a cheap identity
  // check on the raw token tells us when to rebuild the digest.
  /** @type {string | null} */
  let cachedToken = null;
  /** @type {Buffer | null} */
  let cachedDigest = null;

  return function authMiddleware(
    /** @type {any} */ req,
    /** @type {any} */ res,
    /** @type {any} */ next
  ) {
    const header = req.headers?.authorization || '';
    if (Buffer.byteLength(header, 'utf8') > MAX_AUTH_VALUE_BYTES) return _deny(res);
    const bearerMatch = /^Bearer\s+(.+)$/.exec(header);
    if (!bearerMatch) return _deny(res);
    const provided = bearerMatch[1];
    const expected = getToken();
    if (typeof expected !== 'string' || expected.length === 0) return _deny(res);
    if (expected !== cachedToken) {
      cachedToken = expected;
      cachedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
    }
    // Hash provided side per-request (unavoidable, varies by client) but
    // reuse the cached expected digest. timingSafeEqual requires equal-
    // length buffers — sha256 normalizes both to 32 bytes, absorbing any
    // length mismatch in constant time.
    const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
    if (!cachedDigest || !crypto.timingSafeEqual(a, cachedDigest)) return _deny(res);
    next();
  };
}

function _deny(/** @type {any} */ res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } }));
}

module.exports = { createAuthMiddleware, MAX_AUTH_VALUE_BYTES };
