/**
 * Static guard: every package a worker bundle requires at runtime, with its
 * whole installed dependency closure, is covered by electron-builder.json
 * asarUnpack.
 *
 * A packaged worker runs from resources/app.asar.unpacked/dist, so Node
 * resolves its externals (and their dependencies) from
 * app.asar.unpacked/node_modules only, never from app.asar where dist/main.js
 * finds them. Regression (clean-machine packaged run, 2026-11): asarUnpack
 * held pino but not pino-std-serializers & co, and the embedding, OCR,
 * image-preprocess and log-export workers all crashed on load in packaged
 * builds only. The packaged-build twin of this check runs in
 * scripts/verify-packaged-artifacts.js (verifyWorkerExternalsResolve).
 */

// Reads the real node_modules, webpack config and worker sources.
jest.unmock('fs');
jest.unmock('fs/promises');

const fs = require('fs');
const path = require('path');

const {
  findWorkerExternalsOutsideAsarUnpack,
  getWorkerExternalPackagesFromSource
} = require('../scripts/verify-packaged-artifacts');

const repoRoot = path.join(__dirname, '..');

describe('worker externals are unpacked with their full dependency closure', () => {
  test('every worker external closure in the repo is covered by asarUnpack', () => {
    // Runs against the installed node_modules, so a dependency bump that adds
    // a package to a worker external's closure fails here instead of in a
    // packaged build.
    expect(findWorkerExternalsOutsideAsarUnpack()).toEqual([]);
  });

  test('flags the asarUnpack list that shipped the crash', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'electron-builder.json'), 'utf8')
    );
    // The pre-fix list: pino, sharp and tesseract.js unpacked, none of their deps.
    const preFix = config.asarUnpack.filter(
      (pattern) => !/pino-std-serializers|detect-libc|regenerator-runtime/.test(pattern)
    );

    expect(findWorkerExternalsOutsideAsarUnpack({ asarUnpack: preFix })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^embeddingWorker: pino -> pino-std-serializers /),
        expect.stringMatching(/^imagePreprocessWorker: sharp -> detect-libc /),
        expect.stringMatching(/^ocrWorker: tesseract\.js -> regenerator-runtime /)
      ])
    );
  });

  test('requires a pattern that covers a package wherever electron-builder hoists it', () => {
    // tesseract.js/node_modules/node-fetch in the repo ships as a top-level
    // node_modules/node-fetch, which **/node_modules/tesseract.js/** misses.
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'electron-builder.json'), 'utf8')
    );
    const withoutNodeFetch = config.asarUnpack.map((pattern) => pattern.replace('node-fetch,', ''));

    expect(findWorkerExternalsOutsideAsarUnpack({ asarUnpack: withoutNodeFetch })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ocrWorker: tesseract\.js -> node-fetch /)])
    );
  });

  test('worker externals read from source match the webpack externals', () => {
    const externals = Object.fromEntries(getWorkerExternalPackagesFromSource());
    // node-llama-cpp is not a literal import: in packaged builds the embedding
    // worker imports the app.asar copy (resolveNodeLlamaCppSpecifier), so its
    // ~100 dependencies need not be unpacked.
    expect(externals.embeddingWorker).toEqual(['pino']);
    expect(externals.ocrWorker).toEqual(['pino', 'tesseract.js']);
    expect(externals.imagePreprocessWorker).toEqual(['pino', 'sharp']);
    expect(externals.logExportWorker).toEqual(['pino']);
    expect(externals.oramaRestoreWorker).toEqual(['lz4-napi']);
  });
});
