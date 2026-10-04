// @ts-check
'use strict';

const PROVIDER_BASE_URL_RULE = 'baseUrl must use https or be a true localhost URL';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Single source of truth for which provider base URLs may receive a bearer
 * key. Only https, or plain http to a true loopback host, is allowed. The
 * hostname is parsed rather than prefix-matched: `http://localhost.attacker`
 * and `http://127.0.0.1@evil.com/` both start with a loopback-looking string
 * but resolve to a remote host. IPv6 brackets are stripped because the WHATWG
 * parser has emitted `[::1]` and `::1` across Node versions.
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedProviderBaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''));
}

module.exports = { PROVIDER_BASE_URL_RULE, isAllowedProviderBaseUrl };
