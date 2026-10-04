// @ts-check
'use strict';

// Per-session rate limiter. The middleware runs AFTER auth, so every caller
// here holds the (single, shared) bearer token and the Mcp-Session-Id header
// is a server-issued UUID. Keying on remote address + session id gives each
// connected client (Claude Desktop, Cursor, Zed, … all on 127.0.0.1) its own
// bucket, so one spammy client can't starve the others, while header-less
// initialize traffic shares a single "init" bucket. Buckets are capped at
// MAX_BUCKETS with LRU eviction to bound memory under session churn.
const DEFAULT_LIMIT_PER_MIN = 60;
const MAX_BUCKETS = 64;
const INIT_BUCKET = 'init';

function _peerKey(/** @type {any} */ req) {
  const remote = req?.socket?.remoteAddress || 'unknown';
  const header = req?.headers?.['mcp-session-id'];
  const sessionId = Array.isArray(header) ? header[0] : header;
  return `${remote}|${typeof sessionId === 'string' && sessionId ? sessionId : INIT_BUCKET}`;
}

function createRateLimit({ limitPerMin = DEFAULT_LIMIT_PER_MIN } = {}) {
  // Map preserves insertion order; we evict the oldest entry when over cap.
  const buckets = new Map();

  function getBucket(/** @type {any} */ key) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limitPerMin, last: Date.now() };
      buckets.set(key, bucket);
      if (buckets.size > MAX_BUCKETS) {
        const oldestKey = buckets.keys().next().value;
        buckets.delete(oldestKey);
      }
    } else {
      // Refresh LRU position
      buckets.delete(key);
      buckets.set(key, bucket);
    }
    return bucket;
  }

  return function rateLimit(
    /** @type {any} */ req,
    /** @type {any} */ res,
    /** @type {any} */ next
  ) {
    const bucket = getBucket(_peerKey(req));
    const now = Date.now();
    const elapsedMin = (now - bucket.last) / 60000;
    bucket.tokens = Math.min(limitPerMin, bucket.tokens + elapsedMin * limitPerMin);
    bucket.last = now;
    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil(60 / limitPerMin);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32004, message: 'Rate limit exceeded' } })
      );
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}

module.exports = { createRateLimit };
