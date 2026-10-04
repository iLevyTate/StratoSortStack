/**
 * Offline license verification and the informational status matrix. There is
 * no trial: without a key the state is `free`, whatever the clock says.
 *
 * Keys are minted in-test with a throwaway Ed25519 pair using the EXACT
 * format scripts/license/sign-license.js produces, so these oracles pin the
 * signer<->verifier contract end to end.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  LicenseService,
  verifyLicenseKey,
  LICENSE_STATES
} = require('../src/main/services/LicenseService');

const DAY_MS = 24 * 60 * 60 * 1000;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' });

function mintKey(payloadOverrides = {}) {
  const payload = {
    name: 'Ada Lovelace',
    emailHash: crypto.createHash('sha256').update('ada@example.com').digest('hex'),
    edition: 'personal',
    seats: 1,
    issuedAt: '2026-07-03',
    maintenanceUntil: '2027-07-03',
    ...payloadOverrides
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKey);
  return `SSORT1-${payloadB64}.${sig.toString('base64url')}`;
}

function makeService({ nowMs, buildDate = null, dir }) {
  let current = nowMs;
  const service = new LicenseService({
    userDataPath: dir,
    publicKeyPem: PUB_PEM,
    buildDate,
    now: () => current
  });
  return { service, setNow: (ms) => (current = ms) };
}

describe('verifyLicenseKey', () => {
  test('valid signed key verifies and yields the payload', () => {
    const result = verifyLicenseKey(mintKey(), PUB_PEM);
    expect(result.valid).toBe(true);
    expect(result.payload.edition).toBe('personal');
    expect(result.payload.maintenanceUntil).toBe('2027-07-03');
  });

  test.each([
    ['tampered payload byte', (k) => k.replace('SSORT1-e', 'SSORT1-f')],
    [
      'tampered signature byte',
      (k) => `${k.slice(0, -2)}${k.slice(-2, -1) === 'A' ? 'B' : 'A'}${k.slice(-1)}`
    ],
    ['wrong prefix', (k) => `XXORT1-${k.slice(7)}`],
    ['missing signature segment', (k) => k.split('.')[0]],
    ['empty string', () => ''],
    ['non-string', () => null]
  ])('%s fails verification', (_label, mutate) => {
    const result = verifyLicenseKey(mutate(mintKey()), PUB_PEM);
    expect(result.valid).toBe(false);
  });

  test('signature from a DIFFERENT keypair fails', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const payloadB64 = mintKey().slice(7).split('.')[0];
    const foreignSig = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), other.privateKey);
    const forged = `SSORT1-${payloadB64}.${foreignSig.toString('base64url')}`;
    expect(verifyLicenseKey(forged, PUB_PEM).valid).toBe(false);
  });

  test('payload without maintenanceUntil is rejected even when signed', () => {
    const key = mintKey({ maintenanceUntil: undefined });
    expect(verifyLicenseKey(key, PUB_PEM).valid).toBe(false);
  });
});

describe('LicenseService status matrix', () => {
  let dir;
  const T0 = Date.parse('2026-07-03T12:00:00Z');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssort-license-'));
  });

  test('fresh install is free, with no countdown', async () => {
    const { service } = makeService({ nowMs: T0, dir });
    const snapshot = await service.initialize();
    expect(snapshot.state).toBe(LICENSE_STATES.FREE);
    expect(snapshot).not.toHaveProperty('daysLeft');
  });

  test('a year later with no key is still free', async () => {
    const { service, setNow } = makeService({ nowMs: T0, dir });
    await service.initialize();
    setNow(T0 + 365 * DAY_MS);
    expect(service.getSnapshot().state).toBe(LICENSE_STATES.FREE);
  });

  // The public release ships to machines that ran the trial build. Their
  // license.json carries firstRunAt/lastSeenAt from months ago; it must not
  // turn back into an expired trial.
  test('an install whose old trial expired reads as free', async () => {
    fs.writeFileSync(
      path.join(dir, 'license.json'),
      JSON.stringify({
        firstRunAt: T0 - 90 * DAY_MS,
        lastSeenAt: T0 - 30 * DAY_MS,
        key: null,
        activatedAt: null,
        personalUseAt: null
      })
    );
    const { service } = makeService({ nowMs: T0, dir });
    const snapshot = await service.initialize();
    expect(snapshot.state).toBe(LICENSE_STATES.FREE);
  });

  test('an old install that attested personal use reads as free', async () => {
    fs.writeFileSync(
      path.join(dir, 'license.json'),
      JSON.stringify({ firstRunAt: T0 - 90 * DAY_MS, personalUseAt: T0 - 60 * DAY_MS })
    );
    const { service } = makeService({ nowMs: T0, dir });
    expect((await service.initialize()).state).toBe(LICENSE_STATES.FREE);
  });

  test('an old install with a key keeps it', async () => {
    fs.writeFileSync(
      path.join(dir, 'license.json'),
      JSON.stringify({ firstRunAt: T0 - 90 * DAY_MS, key: mintKey(), activatedAt: T0 })
    );
    const { service } = makeService({ nowMs: T0, dir });
    const snapshot = await service.initialize();
    expect(snapshot.state).toBe(LICENSE_STATES.LICENSED);
    expect(snapshot.name).toBe('Ada Lovelace');
  });

  test('the service exposes no gate and no attestation', () => {
    const { service } = makeService({ nowMs: T0, dir });
    expect(service.allowsNewAiWork).toBeUndefined();
    expect(service.attestPersonalUse).toBeUndefined();
  });

  test('activate with a valid key -> licensed, and persists across restarts', async () => {
    const { service } = makeService({ nowMs: T0, dir });
    await service.initialize();
    const result = await service.activate(mintKey());
    expect(result.success).toBe(true);
    expect(result.snapshot.state).toBe(LICENSE_STATES.LICENSED);
    expect(result.snapshot.edition).toBe('personal');

    const restarted = makeService({ nowMs: T0 + DAY_MS, dir });
    const snapshot = await restarted.service.initialize();
    expect(snapshot.state).toBe(LICENSE_STATES.LICENSED);
  });

  test('activate with an invalid key is rejected with a reason', async () => {
    const { service } = makeService({ nowMs: T0, dir });
    await service.initialize();
    const result = await service.activate('SSORT1-garbage.alsogarbage');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid license key/);
    expect(service.getSnapshot().state).toBe(LICENSE_STATES.FREE);
  });

  test('deactivate returns to free', async () => {
    const { service } = makeService({ nowMs: T0, dir });
    await service.initialize();
    await service.activate(mintKey());
    await service.deactivate();
    expect(service.getSnapshot().state).toBe(LICENSE_STATES.FREE);

    const restarted = makeService({ nowMs: T0, dir });
    expect((await restarted.service.initialize()).state).toBe(LICENSE_STATES.FREE);
  });

  test('tampered stored key file reads as free instead of crashing', async () => {
    const { service } = makeService({ nowMs: T0, dir });
    await service.initialize();
    await service.activate(mintKey());

    const filePath = path.join(dir, 'license.json');
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    stored.key = stored.key.replace('SSORT1-e', 'SSORT1-f');
    fs.writeFileSync(filePath, JSON.stringify(stored));

    const restarted = makeService({ nowMs: T0, dir });
    const snapshot = await restarted.service.initialize();
    expect(snapshot.state).toBe(LICENSE_STATES.FREE);
  });

  describe('maintenanceUntil vs buildDate (update window)', () => {
    test('build within the maintenance window -> licensed', async () => {
      const { service } = makeService({ nowMs: T0, dir, buildDate: '2027-01-01' });
      await service.initialize();
      const result = await service.activate(mintKey({ maintenanceUntil: '2027-07-03' }));
      expect(result.snapshot.state).toBe(LICENSE_STATES.LICENSED);
    });

    test('build AFTER the maintenance window -> version_not_covered', async () => {
      const { service } = makeService({ nowMs: T0, dir, buildDate: '2027-08-01' });
      await service.initialize();
      const result = await service.activate(mintKey({ maintenanceUntil: '2027-07-03' }));
      expect(result.snapshot.state).toBe(LICENSE_STATES.VERSION_NOT_COVERED);
      expect(result.snapshot.maintenanceUntil).toBe('2027-07-03');
    });

    test('dev build (no buildDate) skips the update-window check', async () => {
      const { service } = makeService({ nowMs: T0, dir, buildDate: null });
      await service.initialize();
      const result = await service.activate(mintKey({ maintenanceUntil: '2020-01-01' }));
      expect(result.snapshot.state).toBe(LICENSE_STATES.LICENSED);
    });

    test('runtime clock NEVER expires a covered license', async () => {
      const { service, setNow } = makeService({ nowMs: T0, dir, buildDate: '2027-01-01' });
      await service.initialize();
      await service.activate(mintKey({ maintenanceUntil: '2027-07-03' }));
      setNow(Date.parse('2030-01-01T00:00:00Z')); // far past maintenanceUntil
      expect(service.getSnapshot().state).toBe(LICENSE_STATES.LICENSED);
    });
  });
});
