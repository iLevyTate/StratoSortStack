/**
 * @jest-environment node
 *
 * Guards the shared native-modules manifest used by `rebuild-native.js`
 * and `verify-native-modules.js`. The drift between those two scripts has
 * caused prebuilt-addon regressions to reach release before; this test
 * locks in the invariants so the next contributor can't silently break
 * them.
 */

const { MODULES, getRebuildTargets, getVerificationChecks } = require('../scripts/native-modules');

describe('scripts/native-modules manifest', () => {
  test('every module declares name, requiresElectronRebuild flag, and verify function', () => {
    expect(MODULES.length).toBeGreaterThan(0);
    for (const mod of MODULES) {
      expect(typeof mod.name).toBe('string');
      expect(mod.name.length).toBeGreaterThan(0);
      expect(typeof mod.requiresElectronRebuild).toBe('boolean');
      expect(typeof mod.verify).toBe('function');
    }
  });

  test('module names are unique', () => {
    const names = MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('getRebuildTargets returns only modules flagged for Electron rebuild', () => {
    const rebuildTargets = getRebuildTargets();
    const expected = MODULES.filter((m) => m.requiresElectronRebuild).map((m) => m.name);
    expect(rebuildTargets).toEqual(expected);
    // Current inventory: node-llama-cpp is the C++ addon that must be rebuilt
    // against Electron's ABI. N-API modules (sharp, @napi-rs/canvas, lz4-napi,
    // better-sqlite3 >= 13) are ABI-stable and must NOT be in this list.
    expect(rebuildTargets).toContain('node-llama-cpp');
    expect(rebuildTargets).not.toContain('better-sqlite3');
    expect(rebuildTargets).not.toContain('sharp');
    expect(rebuildTargets).not.toContain('@napi-rs/canvas');
    expect(rebuildTargets).not.toContain('lz4-napi');
  });

  test('every rebuild target is also covered by a verification check', () => {
    const verifyNames = new Set(getVerificationChecks().map((c) => c.name));
    for (const target of getRebuildTargets()) {
      expect(verifyNames.has(target)).toBe(true);
    }
  });

  test('verification checks cover every declared module', () => {
    const checkNames = getVerificationChecks().map((c) => c.name);
    expect(checkNames).toEqual(MODULES.map((m) => m.name));
  });
});
