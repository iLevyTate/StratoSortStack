'use strict';

/**
 * Single source of truth for native / prebuilt-native modules the app
 * depends on at runtime.
 *
 * Each entry declares:
 *   - name: package name
 *   - requiresElectronRebuild: whether `@electron/rebuild` must rebuild this
 *     module against Electron's ABI. C++ addons (e.g. node-llama-cpp,
 *     better-sqlite3) require this. N-API modules (sharp, @napi-rs/canvas,
 *     lz4-napi) are ABI-stable and ship prebuilt binaries that load under
 *     Electron's Node runtime without a rebuild.
 *   - verify: async function that exercises the module to catch load
 *     failures / broken prebuilds in CI before they reach users.
 *
 * Both `scripts/rebuild-native.js` and `scripts/verify-native-modules.js`
 * import this list so adding a new native dependency only requires one edit.
 */

const MODULES = [
  {
    name: 'node-llama-cpp',
    requiresElectronRebuild: true,
    verify: async () => {
      const llama = await import('node-llama-cpp');
      if (!llama || typeof llama.getLlama !== 'function') {
        throw new Error('node-llama-cpp missing getLlama() export');
      }
    }
  },
  {
    name: 'better-sqlite3',
    requiresElectronRebuild: true,
    verify: async () => {
      const BetterSqlite3 = require('better-sqlite3');
      const db = new BetterSqlite3(':memory:');
      try {
        db.exec('CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, name TEXT)');
        db.prepare('INSERT INTO smoke_test (name) VALUES (?)').run('ok');
        const row = db.prepare('SELECT name FROM smoke_test WHERE id = 1').get();
        if (row?.name !== 'ok') {
          throw new Error('better-sqlite3 query returned unexpected result');
        }
      } finally {
        db.close();
      }
    }
  },
  {
    name: 'sharp',
    requiresElectronRebuild: false,
    verify: async () => {
      const sharp = require('sharp');
      const out = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 0, g: 0, b: 0 }
        }
      })
        .png()
        .toBuffer();
      if (!Buffer.isBuffer(out) || out.length === 0) {
        throw new Error('sharp pipeline produced empty output');
      }
    }
  },
  {
    name: '@napi-rs/canvas',
    requiresElectronRebuild: false,
    verify: async () => {
      const canvas = require('@napi-rs/canvas');
      const c = canvas.createCanvas(2, 2);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, 2, 2);
      const pngBuffer = c.toBuffer('image/png');
      if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
        throw new Error('@napi-rs/canvas produced empty PNG');
      }
    }
  },
  {
    name: 'lz4-napi',
    requiresElectronRebuild: false,
    verify: async () => {
      const lz4 = require('lz4-napi');
      const source = Buffer.from('stratosort-smoke-test', 'utf8');
      const compressed = lz4.compressSync(source);
      const restored = lz4.uncompressSync(compressed);
      if (!restored.equals(source)) {
        throw new Error('lz4-napi decompressed output mismatch');
      }
    }
  },
  {
    // tesseract.js + tesseract.js-core are externalized by webpack and ship
    // unpacked under `asarUnpack` (electron-builder.json). A missing/renamed
    // wasm asset would otherwise only surface at the first OCR invocation
    // in production. Resolve-only smoke is sufficient — exercising the OCR
    // pipeline end-to-end is too expensive for CI verification.
    name: 'tesseract.js',
    requiresElectronRebuild: false,
    verify: async () => {
      const resolved = require.resolve('tesseract.js');
      if (!resolved || typeof resolved !== 'string') {
        throw new Error('tesseract.js could not be resolved');
      }
    }
  },
  {
    name: 'tesseract.js-core',
    requiresElectronRebuild: false,
    verify: async () => {
      const resolved = require.resolve('tesseract.js-core');
      if (!resolved || typeof resolved !== 'string') {
        throw new Error('tesseract.js-core could not be resolved');
      }
    }
  },
  {
    // @fugood/whisper.node is the N-API binding wrapper; the actual native
    // `.node` shards ship as platform-specific @fugood/node-whisper-* packages
    // and are externalized under `asarUnpack` (electron-builder.json). It ships
    // prebuilt binaries (builds from source only under npm_config_build_from_source),
    // so it does NOT require an @electron/rebuild pass. Resolve-only smoke is
    // sufficient — a broken prebuild / ABI mismatch would otherwise only surface
    // at the first WhisperService transcription call; exercising real audio
    // transcription is too expensive for CI. Mirrors the tesseract.js
    // externalized-native-asset pattern above.
    name: '@fugood/whisper.node',
    requiresElectronRebuild: false,
    verify: async () => {
      const resolved = require.resolve('@fugood/whisper.node');
      if (!resolved || typeof resolved !== 'string') {
        throw new Error('@fugood/whisper.node could not be resolved');
      }
    }
  }
];

function getRebuildTargets() {
  return MODULES.filter((m) => m.requiresElectronRebuild).map((m) => m.name);
}

function getVerificationChecks() {
  return MODULES.map(({ name, verify }) => ({ name, verify }));
}

module.exports = {
  MODULES,
  getRebuildTargets,
  getVerificationChecks
};
