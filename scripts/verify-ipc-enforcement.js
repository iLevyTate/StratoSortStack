#!/usr/bin/env node

/**
 * Verify IPC enforcement set membership (audit item #2).
 *
 * Simply requiring `src/shared/ipcEnforcement.js` is enough — its built-in
 * self-validation throws synchronously if any entry in EVENT_ONLY_CHANNEL_REFS,
 * CONCURRENCY_LIMITED_CHANNEL_REFS, or DOWNLOADS_TRIAGE_MUTATION_CHANNEL_REFS
 * fails to resolve against IPC_CHANNELS in `src/shared/constants.js`.
 *
 * Wiring this into CI catches drift even if no test happens to import the
 * enforcement module on the path you ran. Fast (<100ms), no I/O beyond require.
 */

const path = require('path');

const enforcementPath = path.resolve(__dirname, '..', 'src', 'shared', 'ipcEnforcement.js');

try {
  // Resolve and require — throws synchronously on the first bad entry.
  const enforcement = require(enforcementPath);

  const eventOnly = enforcement.EVENT_ONLY_CHANNELS?.size ?? 0;
  const concurrency = enforcement.CONCURRENCY_LIMITED_CHANNELS?.size ?? 0;
  const triage = enforcement.DOWNLOADS_TRIAGE_MUTATION_CHANNELS?.size ?? 0;
  const total = eventOnly + concurrency + triage;

  if (total === 0) {
    console.error('verify-ipc-enforcement: refused to pass with zero enforcement entries');
    process.exit(1);
  }

  console.log(
    `verify-ipc-enforcement: OK — ${total} entries validated ` +
      `(event-only=${eventOnly}, concurrency-limited=${concurrency}, ` +
      `triage-mutation=${triage})`
  );
  process.exit(0);
} catch (err) {
  console.error('verify-ipc-enforcement: FAILED');
  console.error(err.stack || err.message || String(err));
  process.exit(1);
}
