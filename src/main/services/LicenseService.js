// @ts-check
/**
 * Offline commercial-license status.
 *
 * StratoSort is free for personal and noncommercial use under PolyForm
 * Noncommercial 1.0.0; commercial use is sold separately as a signed key.
 * This service only reports which of those applies. Nothing in the app is
 * gated on it: there is no trial, no expiry and no feature that stops working.
 *
 *  - Keys are Ed25519-signed strings: `SSORT1-<b64url(payload)>.<b64url(sig)>`.
 *    The signature covers the exact base64url payload segment (utf8 bytes), so
 *    verification never depends on JSON canonicalization. Only the PUBLIC key
 *    ships (src/shared/licensePublicKey.js); verification is fully offline.
 *  - Payload: { name, emailHash, edition, seats, issuedAt, maintenanceUntil,
 *    maxVersion? }. `maintenanceUntil` says which builds the key's update
 *    window covers (buildDate <= maintenanceUntil). A build outside it reports
 *    `version_not_covered`, which Settings shows as a notice.
 *  - State lives in its own atomic file (userData/license.json), deliberately
 *    NOT settings.json, so settings export/import/backup flows never leak or
 *    clobber a stored key. Older builds also wrote trial timestamps there;
 *    they are ignored and dropped on the next write.
 */

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { atomicWriteFile } = require('../../shared/atomicFile');
const { LICENSE_PUBLIC_KEY_PEM } = require('../../shared/licensePublicKey');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('LicenseService');

const KEY_PREFIX = 'SSORT1-';
const LICENSE_FILE = 'license.json';

const LICENSE_STATES = Object.freeze({
  /** No commercial key: free for personal and noncommercial use. */
  FREE: 'free',
  LICENSED: 'licensed',
  VERSION_NOT_COVERED: 'version_not_covered'
});

function base64UrlDecode(/** @type {any} */ segment) {
  return Buffer.from(segment, 'base64url');
}

/**
 * Parse + cryptographically verify a license key string.
 * Pure function of (key, publicKeyPem) — no I/O, no clock.
 *
 * @returns {{ valid: true, payload: Record<string, any> } | { valid: false, reason: string }}
 */
function verifyLicenseKey(/** @type {any} */ key, publicKeyPem = LICENSE_PUBLIC_KEY_PEM) {
  if (typeof key !== 'string') return { valid: false, reason: 'not a string' };
  const trimmed = key.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) {
    return { valid: false, reason: 'unrecognized key format' };
  }
  const body = trimmed.slice(KEY_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) {
    return { valid: false, reason: 'malformed key (missing signature)' };
  }
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);

  let signatureOk;
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    signatureOk = crypto.verify(
      null,
      Buffer.from(payloadB64, 'utf8'),
      publicKey,
      base64UrlDecode(sigB64)
    );
  } catch (error) {
    return { valid: false, reason: `verification error: ${error.message}` };
  }
  if (!signatureOk) return { valid: false, reason: 'signature mismatch' };

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'payload is not valid JSON' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'payload is not an object' };
  }
  if (typeof payload.maintenanceUntil !== 'string' || !payload.maintenanceUntil) {
    return { valid: false, reason: 'payload missing maintenanceUntil' };
  }
  return { valid: true, payload };
}

class LicenseService {
  /**
   * @param {object} [options]
   * @param {string} [options.userDataPath] Defaults to Electron userData.
   * @param {string} [options.publicKeyPem] Verification key (tests inject a throwaway pair).
   * @param {string|null} [options.buildDate] ISO date of this build (electron-builder
   *   extraMetadata); null (dev builds) skips version-coverage checks.
   * @param {() => number} [options.now] Clock injection for tests.
   */
  constructor({ userDataPath, publicKeyPem, buildDate, now } = {}) {
    if (!userDataPath) {
      // Lazy require so unit tests can construct without an Electron app.
      const { app } = require('electron');
      userDataPath = app.getPath('userData');
    }
    this._filePath = path.join(userDataPath, LICENSE_FILE);
    this._publicKeyPem = publicKeyPem || LICENSE_PUBLIC_KEY_PEM;
    this._buildDate = buildDate ?? null;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._state = null; // { key, activatedAt }
  }

  async initialize() {
    let stored = null;
    try {
      stored = JSON.parse(await fs.readFile(this._filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('[License] Unreadable license state; starting fresh', {
          error: error.message
        });
      }
    }
    this._state = {
      key: typeof stored?.key === 'string' ? stored.key : null,
      activatedAt: Number.isFinite(stored?.activatedAt) ? stored.activatedAt : null
    };
    const snapshot = this.getSnapshot();
    logger.info('[License] Initialized', {
      state: snapshot.state,
      edition: snapshot.edition
    });
    return snapshot;
  }

  /**
   * Validate and persist a license key.
   * @returns {Promise<{ success: boolean, error?: string, snapshot?: object }>}
   */
  async activate(/** @type {any} */ key) {
    const result = verifyLicenseKey(key, this._publicKeyPem);
    if (!result.valid) {
      const reason = /** @type {{ reason: string }} */ (result).reason;
      logger.warn('[License] Activation rejected', { reason });
      return { success: false, error: `Invalid license key: ${reason}` };
    }
    this._ensureInitialized();
    this._state.key = String(key).trim();
    this._state.activatedAt = this._now();
    await this._persist();
    const snapshot = this.getSnapshot();
    logger.info('[License] Activated', {
      edition: snapshot.edition,
      state: snapshot.state,
      maintenanceUntil: snapshot.maintenanceUntil
    });
    return { success: true, snapshot };
  }

  /**
   * Remove the stored key from this device.
   */
  async deactivate() {
    this._ensureInitialized();
    this._state.key = null;
    this._state.activatedAt = null;
    await this._persist();
    logger.info('[License] Deactivated');
    return { success: true, snapshot: this.getSnapshot() };
  }

  /**
   * @returns {Record<string, any>} snapshot with state, edition, name, seats, maintenanceUntil, buildDate
   */
  getSnapshot() {
    this._ensureInitialized();
    /** @type {Record<string, any>} */
    const base = {
      edition: null,
      name: null,
      seats: null,
      maintenanceUntil: null,
      buildDate: this._buildDate
    };

    if (this._state.key) {
      const result = verifyLicenseKey(this._state.key, this._publicKeyPem);
      if (result.valid) {
        const { payload } = result;
        const covered =
          !this._buildDate ||
          !payload.maintenanceUntil ||
          new Date(this._buildDate).getTime() <= new Date(payload.maintenanceUntil).getTime();
        return {
          ...base,
          state: covered ? LICENSE_STATES.LICENSED : LICENSE_STATES.VERSION_NOT_COVERED,
          edition: payload.edition ?? null,
          name: payload.name ?? null,
          seats: Number.isFinite(payload.seats) ? payload.seats : null,
          maintenanceUntil: payload.maintenanceUntil ?? null
        };
      }
      // A stored key that no longer verifies (tampered file, key rotation)
      // reads as no key rather than crashing the app.
      logger.warn('[License] Stored key failed verification; treating as unlicensed', {
        reason: /** @type {{ reason: string }} */ (result).reason
      });
    }

    return { ...base, state: LICENSE_STATES.FREE };
  }

  _ensureInitialized() {
    if (!this._state) {
      throw new Error('LicenseService used before initialize()');
    }
  }

  async _persist() {
    await atomicWriteFile(this._filePath, this._state, { pretty: true });
  }
}

module.exports = { LicenseService, verifyLicenseKey, LICENSE_STATES, KEY_PREFIX };
