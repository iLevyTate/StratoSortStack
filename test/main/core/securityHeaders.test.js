'use strict';

const {
  buildContentSecurityPolicy,
  STATIC_SECURITY_HEADERS,
  toWebRequestHeaderArrays
} = require('../../../src/main/core/securityHeaders');

describe('securityHeaders', () => {
  describe('buildContentSecurityPolicy', () => {
    test('production policy is locked down to self', () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      // connect-src must not open up to localhost in production
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain('127.0.0.1');
    });

    test('script-src stays strict — no unsafe-eval / unsafe-inline, splash hashes allowed', () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
      expect(scriptSrc).not.toContain('unsafe-eval');
      expect(scriptSrc).not.toContain('unsafe-inline');
    });

    test('dev policy opens connect-src to local webpack / HMR origins', () => {
      const csp = buildContentSecurityPolicy({ isDev: true });
      expect(csp).toContain('http://127.0.0.1:*');
      expect(csp).toContain('ws://localhost:*');
    });

    test('S-1: production style-src-elem is hash-allowlisted, no unsafe-inline', () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      const elem = csp.split(';').find((d) => d.trim().startsWith('style-src-elem'));
      expect(elem).toContain("'self'");
      expect(elem).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
      expect(elem).not.toContain('unsafe-inline');
    });

    test('S-1: dev style-src-elem allows unsafe-inline (style-loader <style> tags)', () => {
      const csp = buildContentSecurityPolicy({ isDev: true });
      const elem = csp.split(';').find((d) => d.trim().startsWith('style-src-elem'));
      expect(elem).toContain("'unsafe-inline'");
    });

    test('dev style-src-elem carries NO hashes — a hash/nonce in the list makes browsers ignore unsafe-inline, blocking every style-loader <style> tag (the unstyled-app regression)', () => {
      const csp = buildContentSecurityPolicy({ isDev: true });
      const elem = csp.split(';').find((d) => d.trim().startsWith('style-src-elem'));
      expect(elem).not.toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
      expect(elem).not.toContain('nonce-');
    });

    test('S-1: style-src-attr keeps unsafe-inline; no bare style-src fallback remains', () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("style-src-attr 'unsafe-inline'");
      // elem/attr replace the blanket directive — a bare style-src would
      // reintroduce unsafe-inline for <style> elements in engines honoring it.
      const bare = csp.split(';').find((d) => /^\s*style-src\s/.test(d));
      expect(bare).toBeUndefined();
    });

    test('uses isDevelopment() default when called with no args', () => {
      expect(() => buildContentSecurityPolicy()).not.toThrow();
    });
  });

  describe('STATIC_SECURITY_HEADERS', () => {
    test('pins the intended non-CSP header policy', () => {
      expect(STATIC_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
      expect(STATIC_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
      expect(STATIC_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
      expect(STATIC_SECURITY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
      expect(STATIC_SECURITY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
      expect(STATIC_SECURITY_HEADERS['Permissions-Policy']).toContain('geolocation=()');
    });

    test('retains the legacy X-XSS-Protection header (intentional, per CLAUDE.md)', () => {
      // Documented decision: kept for security-scanner scores / defense-in-depth
      // even though Chrome 78+ ignores it. Guard against accidental removal.
      expect(STATIC_SECURITY_HEADERS['X-XSS-Protection']).toBe('1; mode=block');
    });
  });

  describe('toWebRequestHeaderArrays', () => {
    test('wraps each header value in a single-element array', () => {
      const arrays = toWebRequestHeaderArrays();
      expect(Object.keys(arrays).sort()).toEqual(Object.keys(STATIC_SECURITY_HEADERS).sort());
      for (const [key, value] of Object.entries(arrays)) {
        expect(value).toEqual([STATIC_SECURITY_HEADERS[key]]);
      }
    });
  });
});
