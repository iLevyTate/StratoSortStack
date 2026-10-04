#!/usr/bin/env node
/**
 * Static scan for STRATOSORT_* environment variable names referenced in src/.
 * Run: node scripts/audit-env-vars.js
 * Does not evaluate code; use output to keep docs/CONFIG.md and .env.example aligned.
 *
 * Patterns covered:
 *   process.env.X            — direct member access
 *   process.env['X']         — bracket access
 *   env.X                    — aliased (e.g. function param `env`)
 *   getEnvBool('X')          — helper functions in src/shared/envHelpers and friends
 *   envVar: 'X'              — config-schema declarations (configSchema.js)
 *
 * Derived (DERIVED_PATTERNS): some vars are read via a computed template key
 * (`process.env[`STRATOSORT_${name}_BACKEND`]`) the literal regexes above can
 * never see. These reconstruct the var name from a call-site argument so the
 * env-docs gate still catches "added a store, forgot to document its override".
 *
 * Adding a new helper? Add its pattern here so the verifier doesn't get a false negative.
 */

const fs = require('fs');
const path = require('path');

// Scan src/ (runtime app) and scripts/ (build/setup/debug tooling). Both
// produce operator-facing env vars that belong in docs/CONFIG.md.
const SCAN_ROOTS = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'scripts')];

// scripts/audit-env-vars.js and scripts/verify-env-docs.js mention env-var
// names in their own help text / patterns, not as actual reads. Skip them.
const SKIP_FILES = new Set([
  path.join(__dirname, 'audit-env-vars.js'),
  path.join(__dirname, 'verify-env-docs.js')
]);

const PATTERNS = [
  /process\.env\.(STRATOSORT_[A-Z0-9_]+)/g,
  /process\.env\[\s*['"](STRATOSORT_[A-Z0-9_]+)['"]\s*\]/g,
  // Aliased env access: `function foo(env) { return env.STRATOSORT_X }`. The
  // `\b` boundary keeps us from matching `myObject.env.STRATOSORT_X` patterns
  // we'd want anyway, while excluding `processEnv.STRATOSORT_X` typos etc.
  /\benv\.(STRATOSORT_[A-Z0-9_]+)/g,
  // Config-schema declarations: `{ envVar: 'STRATOSORT_X', ... }`
  /envVar\s*:\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g,
  /getEnvBool\(\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g,
  /getEnvInt\(\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g,
  /getEnvOrDefault\(\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g,
  /readEnvFlag\(\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g,
  /resolveCpuPoolThreads\(\s*['"](STRATOSORT_[A-Z0-9_]+)['"]/g
];

// Patterns whose capture group is NOT the env-var name but an input from which
// the name is derived. `derive` must reproduce the runtime's own key
// construction exactly so the documented name matches what is actually read.
const DERIVED_PATTERNS = [
  {
    // src/main/utils/sqliteStore.js shouldUseSqliteBackend(name) reads
    //   process.env[`STRATOSORT_${name.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_BACKEND`]
    // e.g. shouldUseSqliteBackend('embeddingQueue') -> STRATOSORT_EMBEDDINGQUEUE_BACKEND.
    pattern: /shouldUseSqliteBackend\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    derive: (name) => `STRATOSORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BACKEND`
  }
];

function walkJsFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJsFiles(p, acc);
    } else if (/\.(js|jsx|cjs|mjs)$/.test(ent.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function collectVars() {
  const found = new Set();
  const files = SCAN_ROOTS.flatMap((root) => walkJsFiles(root));
  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.add(match[1]);
      }
    }
    for (const { pattern, derive } of DERIVED_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.add(derive(match[1]));
      }
    }
  }
  return [...found].sort();
}

function main() {
  const vars = collectVars();
  console.log('# STRATOSORT_* references in src/ + scripts/ (static audit)\n');
  console.log('| Variable |');
  console.log('| :------- |');
  for (const v of vars) {
    console.log(`| \`${v}\` |`);
  }
  console.log(`\n_Total: ${vars.length} distinct names._`);
}

main();
