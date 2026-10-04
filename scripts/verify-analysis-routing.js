#!/usr/bin/env node
/**
 * Verify Analysis Routing
 *
 * Statically asserts that every supported extension in
 * src/shared/constants.js reaches the correct analyzer bucket via
 * BatchAnalysisService.partitionFilesByModality.
 *
 * This gate exists because earlier feature work shipped a complete
 * media-analysis subsystem (WhisperService, MediaTranscoder, vision
 * keyframe captioning) without wiring the dispatcher above it. Each
 * underlying module's unit tests passed in isolation but no
 * integration check asserted that .mp3 / .mp4 actually reached
 * analyzeMediaFile. This script is the regression-prevention
 * mechanism for that class of bug.
 *
 * Contract: every extension in
 *   - SUPPORTED_AUDIO_EXTENSIONS  → 'media'
 *   - SUPPORTED_VIDEO_EXTENSIONS  → 'media'
 *   - SUPPORTED_IMAGE_EXTENSIONS  → 'images'
 *   - SUPPORTED_TEXT_EXTENSIONS + SUPPORTED_DOCUMENT_EXTENSIONS → 'documents'
 *
 * Other extension families (3D, archive, design) are not asserted
 * here; they fall through to documents today and that's the
 * existing convention.
 *
 * Exit codes:
 *   0 — all routing assertions hold
 *   1 — one or more assertions failed; per-extension diff printed to stderr
 */

// Stub `electron` so we can require watcher modules in a plain Node context.
// The watchers (and their transitive deps) call `app.getPath('userData')` at
// module load to resolve cache paths. We don't need real values for static
// dispatch verification — only the helper exports.
const Module = require('module');
const electronStub = {
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    isReady: () => false,
    on: () => undefined,
    once: () => undefined,
    whenReady: () => Promise.resolve()
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  Notification: class {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, ...rest);
};

const {
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_TEXT_EXTENSIONS,
  SUPPORTED_DOCUMENT_EXTENSIONS
} = require('../src/shared/constants');

const { partitionFilesByModality } = require('../src/main/services/analysisRouting');

// Watcher dispatch helpers (exported for this gate). Required after the
// partitioner so the partitioner failures are still reported even if a
// watcher module throws at load time on a future refactor — but a load
// failure is itself a gate failure: silently skipping the watcher checks
// would let the exact bug class this script exists to catch ship again.
let smartFolderChooseAnalyzer = null;
let downloadChooseAnalyzer = null;
const watcherLoadFailures = [];
try {
  ({
    chooseAnalyzerForFile: smartFolderChooseAnalyzer
  } = require('../src/main/services/SmartFolderWatcher'));
} catch (err) {
  watcherLoadFailures.push({ module: 'SmartFolderWatcher', error: err.message });
}
try {
  ({
    chooseAnalyzerForFile: downloadChooseAnalyzer
  } = require('../src/main/services/DownloadWatcher'));
} catch (err) {
  watcherLoadFailures.push({ module: 'DownloadWatcher', error: err.message });
}

function buildExpectedMap() {
  const expected = new Map();
  for (const ext of SUPPORTED_AUDIO_EXTENSIONS) expected.set(ext, 'media');
  for (const ext of SUPPORTED_VIDEO_EXTENSIONS) expected.set(ext, 'media');
  for (const ext of SUPPORTED_IMAGE_EXTENSIONS) expected.set(ext, 'images');
  for (const ext of SUPPORTED_TEXT_EXTENSIONS) expected.set(ext, 'documents');
  for (const ext of SUPPORTED_DOCUMENT_EXTENSIONS) {
    if (!expected.has(ext)) expected.set(ext, 'documents');
  }
  return expected;
}

function locateBucket(partitioned, syntheticPath) {
  for (const bucket of ['documents', 'images', 'media']) {
    if (Array.isArray(partitioned[bucket]) && partitioned[bucket].includes(syntheticPath)) {
      return bucket;
    }
  }
  return null;
}

function main() {
  const expected = buildExpectedMap();
  const extensions = Array.from(expected.keys());
  const syntheticPaths = extensions.map((ext) => `/__verify_routing__/sample${ext}`);

  const partitioned = partitionFilesByModality(syntheticPaths);

  const failures = [];
  for (const ext of extensions) {
    const synthPath = `/__verify_routing__/sample${ext}`;
    const want = expected.get(ext);
    const got = locateBucket(partitioned, synthPath) || 'none';
    if (got !== want) {
      failures.push({ ext, expected: want, actual: got });
    }
  }

  if (failures.length > 0) {
    console.error('Analysis routing verification FAILED:');
    console.error('');
    console.error(`  Extension     Expected   Actual`);
    console.error(`  ─────────────────────────────────`);
    for (const f of failures) {
      const padExt = f.ext.padEnd(13);
      const padExpected = f.expected.padEnd(10);
      console.error(`  [FAIL] ${padExt} expected=${padExpected} actual=${f.actual}`);
    }
    console.error('');
    console.error(
      `  ${failures.length} of ${extensions.length} extensions misrouted. See ` +
        `scripts/verify-analysis-routing.js for the contract.`
    );
    process.exit(1);
  }

  // Watcher dispatch parity check. Audio/video extensions must reach the
  // 'media' analyzer in BOTH watchers when analyzeMediaFile is wired.
  // This closes the same isolation-vs-integration gap that this gate was
  // originally designed to close — the partitioner check above only
  // validates BatchAnalysisService; the watchers are a parallel consumer.
  const watcherFailures = [];
  const mediaExts = [...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS];
  if (typeof smartFolderChooseAnalyzer === 'function') {
    for (const ext of mediaExts) {
      const got = smartFolderChooseAnalyzer(`/__verify__/sample${ext}`, {
        hasMediaAnalyzer: true
      });
      if (got !== 'media') {
        watcherFailures.push({
          watcher: 'SmartFolderWatcher',
          ext,
          expected: 'media',
          actual: got
        });
      }
    }
    // Backward-compat: when analyzeMediaFile isn't wired, media falls through
    // to 'document' (preserves pre-fix behavior, never crashes).
    const fallback = smartFolderChooseAnalyzer('/__verify__/sample.mp3', {
      hasMediaAnalyzer: false
    });
    if (fallback !== 'document') {
      watcherFailures.push({
        watcher: 'SmartFolderWatcher (no media analyzer)',
        ext: '.mp3',
        expected: 'document',
        actual: fallback
      });
    }
  }
  if (typeof downloadChooseAnalyzer === 'function') {
    for (const ext of mediaExts) {
      const got = downloadChooseAnalyzer(`/__verify__/sample${ext}`, {
        hasMediaAnalyzer: true
      });
      if (got !== 'media') {
        watcherFailures.push({ watcher: 'DownloadWatcher', ext, expected: 'media', actual: got });
      }
    }
    const fallback = downloadChooseAnalyzer('/__verify__/sample.mp3', {
      hasMediaAnalyzer: false
    });
    if (fallback !== 'document') {
      watcherFailures.push({
        watcher: 'DownloadWatcher (no media analyzer)',
        ext: '.mp3',
        expected: 'document',
        actual: fallback
      });
    }
  }

  if (
    typeof smartFolderChooseAnalyzer !== 'function' &&
    !watcherLoadFailures.some((f) => f.module === 'SmartFolderWatcher')
  ) {
    watcherLoadFailures.push({
      module: 'SmartFolderWatcher',
      error: 'chooseAnalyzerForFile is not exported (or not a function)'
    });
  }
  if (
    typeof downloadChooseAnalyzer !== 'function' &&
    !watcherLoadFailures.some((f) => f.module === 'DownloadWatcher')
  ) {
    watcherLoadFailures.push({
      module: 'DownloadWatcher',
      error: 'chooseAnalyzerForFile is not exported (or not a function)'
    });
  }

  if (watcherFailures.length > 0 || watcherLoadFailures.length > 0) {
    console.error('Watcher dispatch verification FAILED:');
    console.error('');
    for (const f of watcherLoadFailures) {
      console.error(`  [FAIL] ${f.module}: dispatch helper unavailable — ${f.error}`);
    }
    for (const f of watcherFailures) {
      console.error(`  [FAIL] ${f.watcher}: ${f.ext} expected=${f.expected} actual=${f.actual}`);
    }
    console.error('');
    console.error(
      `  ${watcherFailures.length + watcherLoadFailures.length} watcher dispatch problems. ` +
        `See scripts/verify-analysis-routing.js for the contract.`
    );
    process.exit(1);
  }

  console.log(
    `OK: All ${extensions.length} supported extensions route to their expected analyzer bucket; ` +
      `2/2 watcher dispatchers verified for media parity.`
  );
  process.exit(0);
}

main();
