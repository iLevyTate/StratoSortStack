// @ts-check
'use strict';
const ALLOWED_PREFIXES = ['claude://', 'cursor://', 'zed://', 'vscode-webview://'];

// Deny-by-default origin guard.
// Allowed:
//   - missing Origin header (CLI tools, MCP SDK clients, direct Node fetch)
//   - claude://, cursor://, zed://, vscode-webview:// prefixes
// Rejected (everything else), including literal `Origin: null`. Browsers
// send `Origin: null` for sandboxed iframes, redirected requests, file://
// pages, and `<iframe sandbox>` content — exactly the contexts that should
// not reach the MCP server. CLI tools never send the literal string "null".
function createOriginGuard() {
  return function originGuard(
    /** @type {any} */ req,
    /** @type {any} */ res,
    /** @type {any} */ next
  ) {
    const origin = req.headers?.origin;
    if (!origin) return next();
    if (ALLOWED_PREFIXES.some((p) => origin.startsWith(p))) return next();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32003, message: 'ORIGIN_FORBIDDEN' } })
    );
  };
}

module.exports = { createOriginGuard };
