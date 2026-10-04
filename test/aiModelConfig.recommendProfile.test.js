/**
 * recommendInstallProfile: the wizard's hardware-aware profile pick (ML-07).
 * The rule is deliberately small and explainable: Better Quality needs
 * 16 GB of RAM and a GPU with 8 GB; anything else gets Base with a reason
 * naming the limiting fact.
 */
const {
  recommendInstallProfile,
  QUALITY_PROFILE_MIN_RAM_MB,
  QUALITY_PROFILE_MIN_VRAM_MB
} = require('../src/shared/aiModelConfig');

describe('recommendInstallProfile', () => {
  test('floors are 16 GB RAM and 8 GB VRAM', () => {
    expect(QUALITY_PROFILE_MIN_RAM_MB).toBe(16384);
    expect(QUALITY_PROFILE_MIN_VRAM_MB).toBe(8192);
  });

  test('8 GB RAM gets Base and says why', () => {
    const out = recommendInstallProfile({ totalMemMB: 8 * 1024, vramMB: 12 * 1024 });
    expect(out.profile).toBe('base');
    expect(out.reason).toMatch(/8 GB of RAM: the larger profile needs 16 GB/);
  });

  test('32 GB RAM without a GPU gets Base because the 7B model would run on the CPU', () => {
    const out = recommendInstallProfile({ totalMemMB: 32 * 1024, vramMB: 0, hasGpu: false });
    expect(out.profile).toBe('base');
    expect(out.reason).toMatch(/no GPU detected/);
    expect(out.facts.hasGpu).toBe(false);
  });

  test('16 GB RAM with a 6 GB GPU gets Base because of GPU memory', () => {
    const out = recommendInstallProfile({ totalMemMB: 16 * 1024, vramMB: 6 * 1024, hasGpu: true });
    expect(out.profile).toBe('base');
    expect(out.reason).toMatch(/GPU with 6 GB: the larger profile wants 8 GB/);
  });

  test('32 GB RAM and a 12 GB GPU gets Better Quality, naming the GPU', () => {
    const out = recommendInstallProfile({
      totalMemMB: 32 * 1024,
      vramMB: 12 * 1024,
      hasGpu: true,
      gpuName: 'NVIDIA GeForce RTX 4070'
    });
    expect(out.profile).toBe('quality');
    expect(out.reason).toBe(
      '32 GB of RAM and NVIDIA GeForce RTX 4070 (12 GB): this computer can carry the larger models.'
    );
  });

  test('Apple Silicon style facts (unified memory reported as VRAM) qualify at 16 GB', () => {
    const out = recommendInstallProfile({ totalMemMB: 16 * 1024, vramMB: 12 * 1024 });
    expect(out.profile).toBe('quality');
  });

  test('a 16 GB PC reporting 15.7 GB and an 8 GB card reporting 8188 MiB qualify', () => {
    // os.totalmem() leaves out firmware-reserved memory and nvidia-smi
    // rounds down; compared raw, the reason read "16 GB of RAM: needs 16 GB".
    const out = recommendInstallProfile({ totalMemMB: 16077, vramMB: 8188, hasGpu: true });
    expect(out.profile).toBe('quality');
    expect(out.reason).toBe(
      '16 GB of RAM and GPU with 8 GB: this computer can carry the larger models.'
    );
    expect(recommendInstallProfile({ totalMemMB: 15 * 1024 + 400, vramMB: 8188 }).profile).toBe(
      'base'
    );
    expect(recommendInstallProfile({ totalMemMB: 16077, vramMB: 7 * 1024 + 400 }).profile).toBe(
      'base'
    );
  });

  test('a GPU whose memory could not be read gets Base with an honest reason, not "GPU with 0 GB"', () => {
    const out = recommendInstallProfile({ totalMemMB: 32 * 1024, vramMB: null, hasGpu: true });
    expect(out.profile).toBe('base');
    expect(out.reason).toMatch(/memory could not be read/);
    expect(out.reason).not.toMatch(/0 GB/);
    expect(out.facts).toEqual({ totalMemMB: 32 * 1024, vramMB: null, hasGpu: true });
    // A real reading of 0 is still a reading.
    const zero = recommendInstallProfile({ totalMemMB: 32 * 1024, vramMB: 0, hasGpu: true });
    expect(zero.reason).toMatch(/GPU with 0 GB/);
  });

  test('unknown memory falls back to Base', () => {
    const out = recommendInstallProfile({});
    expect(out.profile).toBe('base');
    expect(out.reason).toMatch(/could not be read/);
    expect(out.facts).toEqual({ totalMemMB: null, vramMB: null, hasGpu: false });
  });
});
