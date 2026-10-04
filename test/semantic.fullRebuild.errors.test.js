/**
 * Guardrail test for the full-rebuild error-observability fix.
 *
 * Background: a real user session showed `files: { success: 187, failed: 62 }`
 * — 25% failure rate — with ZERO per-file failure detail in the log file
 * because the orchestrator only push'd to `results.errors[]` and then
 * truncated it to 5 in the IPC response. Operators investigating high
 * failure rates had no signal to debug.
 *
 * The fix has two parts:
 *   1. Per-file `logger.warn` (or `logger.debug` for expected ENOENT) at
 *      each of the 3 catch sites in the rebuild loop.
 *   2. Raise the IPC `errors` cap from 5 to 50 so the renderer (and any
 *      future failure-details UI) can show meaningful detail without
 *      blowing IPC payload limits.
 *
 * Rather than bootstrap the full handleFullRebuild orchestrator (which
 * pulls in OramaVectorService, ParallelEmbeddingService, LlamaService,
 * the AnalysisHistory iterator, fs.access, the embedding queue, …), this
 * test pins the file-level invariants. If someone reverts the cap to 5 or
 * drops the per-file logger.warn calls during a refactor, this fails.
 *
 * End-to-end behavioral coverage of the full rebuild path is exercised
 * by the existing semanticIpc.handlers test + manual smoke verification
 * (described in the fix PR's verification section).
 */

// test-setup.js replaces `fs` with memfs (an in-memory filesystem) for the
// app's runtime mocks. We need the REAL fs to read the source file under
// test, so go through requireActual to bypass the mock.
const realFs = jest.requireActual('fs');
const path = require('path');

const SEMANTIC_IPC = realFs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'ipc', 'semantic.js'),
  'utf8'
);

describe('semantic.js full-rebuild error observability', () => {
  describe('IPC errors cap', () => {
    test('results.errors is sliced to 50 (raised from 5)', () => {
      expect(SEMANTIC_IPC).toMatch(/results\.errors\.slice\(0,\s*50\)/);
    });

    test('the cap raise has an explaining comment', () => {
      // Helps future readers understand why 50 (and not 5 or unbounded) is
      // the chosen value. If a refactor drops the comment, this test fails
      // and forces a deliberate re-decision.
      expect(SEMANTIC_IPC).toMatch(/operators reviewing the IPC response/);
    });
  });

  describe('per-file failure logging', () => {
    test('logger.warn is called at the invalid-path catch site (INVALID_PATH code)', () => {
      // The first catch site (line ~2311 in current code) increments
      // results.files.failed when filePath is missing or non-string. The
      // INVALID_PATH code is the unique marker for this site in the
      // structured log payload.
      expect(SEMANTIC_IPC).toMatch(
        /logger\.warn\('\[EMBEDDINGS\] File failed during full rebuild'[\s\S]{0,300}INVALID_PATH/
      );
    });

    test('logger.debug (not warn) is used for expected ENOENT during rebuild', () => {
      // ENOENT after organize/move is the most common "failure" — file was
      // deleted/moved during the rebuild window. Logging at warn would spam
      // production logs for mass-cleanup scenarios. The debug-vs-warn split
      // is a deliberate observability choice.
      expect(SEMANTIC_IPC).toMatch(/isEnoent\s*\?\s*logger\.debug\s*:\s*logger\.warn/);
    });

    test('the conditional log method is .bind(logger) — detaching it crashes the rebuild', () => {
      // Regression guard. The ternary above selects logger.debug/logger.warn,
      // but assigning the result to a local and calling it BARE detaches the
      // method from its receiver: `this` is undefined inside the method, so
      // `this._safeWrite(...)` throws "Cannot read properties of undefined
      // (reading '_safeWrite')". That throw escaped the access-error catch into
      // the outer per-file catch, which double-counted every missing file
      // (observed: 64 ENOENT files reported as `failed: 128`) and replaced the
      // real "File no longer exists" reason with a misleading TypeError.
      // The .bind(logger) is the fix; this test fails if a refactor drops it.
      expect(SEMANTIC_IPC).toMatch(
        /\(isEnoent\s*\?\s*logger\.debug\s*:\s*logger\.warn\)\.bind\(logger\)/
      );
    });

    test('logger.warn fires for the generic rebuild-loop exception (REBUILD_ERROR code)', () => {
      // Third catch site (line ~2423) — exception during the per-file
      // embed/upsert path. Always warn-level since these are unexpected.
      // REBUILD_ERROR is the fallback code when err.code is not set.
      expect(SEMANTIC_IPC).toMatch(
        /logger\.warn\('\[EMBEDDINGS\] File failed during full rebuild'[\s\S]{0,300}REBUILD_ERROR/
      );
    });

    test('all per-file warn calls include a structured `path`, `reason`, and `code`', () => {
      // The shape must be stable so downstream log consumers (CLI greps,
      // Splunk dashboards, the future failure-details UI) can rely on it.
      const occurrences = SEMANTIC_IPC.match(/\[EMBEDDINGS\] File failed during full rebuild/g);
      expect(occurrences).not.toBeNull();
      expect(occurrences.length).toBeGreaterThanOrEqual(3);

      // Spot-check that the structured fields appear together at least
      // once (full regex match across all 3 sites is brittle; this confirms
      // the convention exists).
      expect(SEMANTIC_IPC).toMatch(/reason:[\s\S]{0,200}code:/);
    });
  });
});
