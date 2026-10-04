#!/usr/bin/env node
/**
 * Verify IPC Renderer Consumers (reverse-direction wiring check)
 *
 * The existing IPC gates (verify-ipc-handlers / verify-ipc-handler-schemas /
 * verify-ipc-contracts) all check the FORWARD direction: every channel in
 * IPC_CHANNELS has a main handler + schema and is bridged in preload. NONE of
 * them check the REVERSE direction — whether each bridged `electronAPI.<ns>.<method>`
 * is ever actually CALLED from the renderer. A feature can be defined + handled +
 * bridged yet never consumed end-to-end, and nothing catches it.
 *
 * This script maps every method exposed on `electronAPI` (in src/preload/preload.js)
 * and reports the ones with no qualified `<namespace>.<method>` reference anywhere
 * in src/renderer. It is ADVISORY: like `npm run knip`, it is intentionally NOT in
 * the `ci` / `local:gate` chain (run it with `npm run verify:ipc-consumers`). Its
 * output is a CANDIDATE list — methods reached only via a fully-destructured name or
 * an aliased namespace will show up here and must be confirmed by hand (the report
 * prints a bare-name hit count to speed that up). Confirmed-intentional indirect
 * access goes in ALLOWLIST below with a rationale.
 *
 * A method can also be genuinely consumed end-to-end by the Playwright e2e suite
 * (test/e2e) without any renderer reference — the per-type `analysis.*` methods, for
 * example, are an intentional contract surface driven directly by the e2e specs
 * (`live-llm-*`, `full-journey`, `whisper-variant-loader`). The renderer-only scan
 * cannot see those, so this script ALSO scans test/e2e for a qualified
 * `<ns>.<method>` reference and reports such methods in a separate `e2e-consumed`
 * bucket instead of mislabeling them strong orphans (audit finding F-067).
 *
 * Usage:
 *   node scripts/verify-ipc-consumers.js
 *
 * Exit codes:
 *   0 - Every exposed method has a qualified renderer consumer (or is allowlisted)
 *   1 - One or more methods have no renderer consumer (candidate orphans)
 *   2 - Could not locate/parse the electronAPI bridge (rig error)
 */

const fs = require('fs');
const path = require('path');

const PRELOAD_PATH = path.join(__dirname, '../src/preload/preload.js');
const RENDERER_DIR = path.join(__dirname, '../src/renderer');
const E2E_DIR = path.join(__dirname, '../test/e2e');

/**
 * Methods exposed on electronAPI that are legitimately consumed in a way the
 * qualified `<ns>.<method>` scan cannot see (fully-destructured method names,
 * alias-renamed namespaces) OR are intentionally unwired (future-facing surface).
 * Each entry MUST carry a one-line rationale so the allowlist stays auditable.
 * Format: 'namespace.method'. Populated during triage (DISCOVER) — keep empty
 * entries out; an unjustified entry is worse than a reported candidate.
 */
const ALLOWLIST = new Set([
  // F-022 — intentional non-UI surface (confirmed during A11 triage):
  'settings.update', // documented "convenience for renderer/tests"; the UI saves via settings.save
  'trace.beginSession', // thin expose of secureIPC.beginTraceSession (internal IPC correlation infra)
  'trace.generateTraceId', // thin expose of secureIPC._generateTraceId (test/debug only)
  'trace.currentTraceId', // thin expose of secureIPC._currentTraceId (test/debug only)

  // Operator decision (2026-06) — F-019 disposition A: load-bearing startup guard; keep bridge.
  'smartFolders.getCustom', // ipcVerification REQUIRED_HANDLERS; no renderer consumer yet
  'smartFolders.updateCustom', // ipcVerification REQUIRED_HANDLERS; no renderer consumer yet
  // Smart-folder watcher trio: internal orchestration + e2e-pinned (soak.spec.js); no UI door.
  'smartFolders.watcherStart',
  'smartFolders.watcherStop',

  // Operator decision (2026-06) — F-020 keep: programmatic OCR outside normal analyze flow.
  'analysis.extractText',

  // Operator decision (2026-06) — F-020 keep: empty-folder cleanup after organize (future UI).
  'files.deleteFolder',

  // Operator decision (2026-06) — F-020 keep: downloads watcher / future UI hook for single-file organize.
  'organize.processNew',

  // Operator decision (2026-06) — F-021 disposition B: clustering/suggestions deferred; backend retained.
  'organize.clusterBatch',
  'organize.identifyOutliers',
  'organize.getClusterSuggestions',
  'suggestions.applyStrategy',
  'suggestions.getUserPatterns',
  'suggestions.clearPatterns',
  'suggestions.suggestNewFolder',
  'embeddings.rebuildBM25Index',
  'embeddings.getSearchStatus',
  'embeddings.diagnoseSearch',
  'embeddings.clearClusters'
]);

/**
 * Locate the `contextBridge.exposeInMainWorld('electronAPI', { ... })` block and
 * return its inner body via brace matching (mirrors the bracket-matching style of
 * verify-ipc-handler-schemas.js — no AST dependency).
 */
function extractElectronApiBody(source) {
  const marker = "contextBridge.exposeInMainWorld('electronAPI', {";
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const openBrace = start + marker.length - 1; // index of the '{'
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBrace + 1, i);
      }
    }
  }
  return null;
}

/**
 * Parse the electronAPI body into { namespace, method, channel } tuples.
 *
 * The bridge is Prettier-formatted with 2-space indentation, so:
 *   - top-level namespaces are lines matching   /^  (\w+): \{/
 *   - their methods are lines matching          /^    (\w+):/
 * A method body is everything from its key line up to the next method key (or the
 * namespace close), and its channel is the first IPC_CHANNELS.X.Y it references.
 */
function parseExposedMethods(body) {
  const lines = body.split('\n');
  const namespaces = [];

  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nsOpen = line.match(/^ {2}(\w+): \{/);
    if (nsOpen) {
      current = { name: nsOpen[1], startLine: i };
      namespaces.push(current);
      continue;
    }
    // A 2-space-indented close brace ends the current namespace.
    if (current && /^ {2}\}/.test(line)) {
      current.endLine = i;
      current = null;
    }
  }
  for (const ns of namespaces) {
    if (ns.endLine == null) ns.endLine = lines.length;
  }

  const methods = [];
  for (const ns of namespaces) {
    const inner = lines.slice(ns.startLine + 1, ns.endLine);
    // Record method-key line indices so we can slice each method's body.
    const keyHits = [];
    for (let i = 0; i < inner.length; i++) {
      const m = inner[i].match(/^ {4}(\w+):/);
      if (m) keyHits.push({ method: m[1], line: i });
    }
    for (let k = 0; k < keyHits.length; k++) {
      const { method, line } = keyHits[k];
      const end = k + 1 < keyHits.length ? keyHits[k + 1].line : inner.length;
      const bodyText = inner.slice(line, end).join('\n');
      const chMatch = bodyText.match(/IPC_CHANNELS\.(\w+)\.(\w+)/);
      methods.push({
        namespace: ns.name,
        method,
        channel: chMatch ? `${chMatch[1]}.${chMatch[2]}` : null
      });
    }
  }
  return methods;
}

/** Recursively collect source files (.js/.jsx/.ts/.tsx) under `dir`. */
function collectSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /\.(jsx?|tsx?)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Main ----
const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
const body = extractElectronApiBody(preloadSource);
if (!body) {
  console.error('ERROR: could not locate the electronAPI exposeInMainWorld block.');
  process.exit(2);
}

const methods = parseExposedMethods(body);
if (methods.length === 0) {
  console.error('ERROR: parsed zero methods from the electronAPI block (parser drift?).');
  process.exit(2);
}

const rendererSource = collectSourceFiles(RENDERER_DIR)
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

// The Playwright e2e suite drives some methods (notably the per-type analysis.*
// contract) directly, with no renderer reference. Scan it separately so those
// methods land in an `e2e-consumed` bucket rather than `strong orphan`.
const e2eSource = collectSourceFiles(E2E_DIR)
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

// Classify each exposed method by how strongly it is referenced.
//   consumed     - a qualified `<ns>.<method>` / `<ns>?.<method>` access exists in the
//                  renderer (clearly wired into the UI).
//   e2eConsumed  - no renderer reference, but a qualified `<ns>.<method>` access exists
//                  in test/e2e. The Playwright suite drives it directly (e.g. the
//                  per-type analysis.* contract), so it is consumed end-to-end even
//                  though no UI code calls it. Reported, but does NOT gate.
//   review       - no qualified access, but the bare method name appears as a call
//                  (`.<method>(`) or a string literal (`'<method>'`). The renderer reaches
//                  the bridge through `_api()` namespace helpers (Redux slices) and
//                  string-dispatch service wrappers (services/ipc/*), which a local
//                  regex cannot tie back to the namespace — so these are LIKELY wired and
//                  must be confirmed by hand rather than treated as dead.
//   orphan       - the method name appears NOWHERE in the renderer (no qualified, no call,
//                  no string) and has no qualified e2e consumer. High-confidence unused
//                  end-to-end. Only this bucket gates.
const orphans = [];
const review = [];
const consumed = [];
const e2eConsumed = [];
const allowlisted = [];

for (const entry of methods) {
  const key = `${entry.namespace}.${entry.method}`;
  if (ALLOWLIST.has(key)) {
    allowlisted.push(entry);
    continue;
  }
  // The renderer overwhelmingly accesses the bridge via optional chaining
  // (`window.electronAPI?.<ns>?.<method>?.(...)`), so the qualified check must
  // accept both `<ns>.<method>` and `<ns>?.<method>`.
  const qualified = new RegExp(
    `\\b${escapeRe(entry.namespace)}\\??\\.${escapeRe(entry.method)}\\b`
  );
  if (qualified.test(rendererSource)) {
    consumed.push(entry);
    continue;
  }
  // A qualified e2e reference is the same high-confidence signal as the renderer
  // one — the method is exercised end-to-end, just from the test harness instead
  // of the UI. Keep it out of the orphan bucket (it is intentionally retained).
  if (qualified.test(e2eSource)) {
    e2eConsumed.push(entry);
    continue;
  }
  const bareHits = (
    rendererSource.match(new RegExp(`\\.${escapeRe(entry.method)}\\s*\\(`, 'g')) || []
  ).length;
  const stringHits = (
    rendererSource.match(new RegExp(`['"]${escapeRe(entry.method)}['"]`, 'g')) || []
  ).length;
  if (bareHits > 0 || stringHits > 0) {
    review.push({ ...entry, bareHits, stringHits });
  } else {
    orphans.push(entry);
  }
}

const total = methods.length;
console.log('\nIPC Renderer-Consumer Report (advisory)');
console.log('='.repeat(50));
console.log(`electronAPI methods exposed:    ${total}`);
console.log(`Consumed (qualified ns.method): ${consumed.length}`);
console.log(`E2E-consumed (qualified, e2e):  ${e2eConsumed.length}`);
console.log(`Review (indirect — confirm):    ${review.length}`);
console.log(`Allowlisted (intentional):      ${allowlisted.length}`);
console.log(`Strong orphans (name absent):   ${orphans.length}`);
console.log();

if (e2eConsumed.length > 0) {
  console.log('E2E-CONSUMED — no renderer reference, but driven by a qualified call in test/e2e');
  console.log('(intentional end-to-end contract surface — keep, not a renderer orphan):');
  const names = e2eConsumed.map((r) => `${r.namespace}.${r.method}`);
  console.log('  ' + names.join(', '));
  console.log();
}

if (review.length > 0) {
  console.log('REVIEW — no qualified <ns>.<method>, but the name appears via a call or string');
  console.log('(likely reached through a _api() helper or services/ipc/* wrapper — confirm):');
  const names = review.map((r) => `${r.namespace}.${r.method}`);
  console.log('  ' + names.join(', '));
  console.log();
}

if (orphans.length > 0) {
  console.log('STRONG ORPHANS — method name absent from all of src/renderer:');
  console.log('-'.repeat(50));
  const byNs = {};
  for (const o of orphans) {
    (byNs[o.namespace] = byNs[o.namespace] || []).push(o);
  }
  for (const [ns, list] of Object.entries(byNs)) {
    console.log(`  ${ns}:`);
    for (const o of list) {
      const ch = o.channel ? ` → ${o.channel}` : ' → (preload-local helper)';
      console.log(`    - ${o.method}${ch}`);
    }
  }
  console.log();
  console.log('These have no renderer reference of any kind. Confirm (destructured import?),');
  console.log('then wire / remove / allowlist with a rationale. Advisory — not in ci.');
  process.exit(1);
} else {
  console.log(
    'OK: no strong orphans. All exposed methods are referenced (directly or indirectly).'
  );
  process.exit(0);
}
