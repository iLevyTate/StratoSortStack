'use strict';

const real = require('../../src/shared/securityConfigPathLimits');
const stub = require('../../src/shared/securityConfigPathLimits.preload-stub');

describe('securityConfigPathLimits preload stub', () => {
  test('export shape matches the real module (no drift between bundles)', () => {
    expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
  });

  test('mirrors the OS path ceilings', () => {
    expect(stub.MAX_PATH_LENGTHS).toEqual(real.MAX_PATH_LENGTHS);
    expect(stub.WIN32_LEGACY_MAX_PATH).toBe(real.WIN32_LEGACY_MAX_PATH);
  });

  test('is optimistic: long-path always enabled, never probes the registry', () => {
    expect(stub.isWindowsLongPathEnabled()).toBe(true);
  });

  test('always returns the full ceiling, including win32 (no legacy 260 cap)', () => {
    expect(stub.getEffectiveMaxPathLength('win32')).toBe(32767);
    expect(stub.getEffectiveMaxPathLength('linux')).toBe(4096);
    expect(stub.getEffectiveMaxPathLength('darwin')).toBe(1024);
    expect(stub.getEffectiveMaxPathLength('sunos')).toBe(stub.MAX_PATH_LENGTHS.linux);
  });
});
