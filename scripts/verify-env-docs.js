#!/usr/bin/env node
/**
 * Verifies that every STRATOSORT_* env var referenced in src/ appears in
 * docs/CONFIG.md, and (optionally) flags doc entries that no longer match
 * any source reference.
 *
 * Wire into CI via `npm run verify:env-docs`. Intended to fail fast on the
 * "added a flag, forgot to document it" drift pattern.
 *
 * The classification policy lives in classifyGap() below. Three approaches
 * are described in the comment there — pick one, fill it in.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIG_DOC = path.join(REPO_ROOT, 'docs', 'CONFIG.md');
const AUDIT_SCRIPT = path.join(__dirname, 'audit-env-vars.js');

function loadCodeRefs() {
  const out = execFileSync(process.execPath, [AUDIT_SCRIPT], { encoding: 'utf8' });
  return new Set([...out.matchAll(/`(STRATOSORT_[A-Z0-9_]+)`/g)].map((m) => m[1]));
}

function loadDocMentions() {
  const text = fs.readFileSync(CONFIG_DOC, 'utf8');
  return new Set([...text.matchAll(/STRATOSORT_[A-Z0-9_]+/g)].map((m) => m[0]));
}

/**
 * Decide what to do about a single var name. Returns:
 *   { status: 'ok' }                    — no action
 *   { status: 'warn', message: '...' }  — log and continue
 *   { status: 'fail', message: '...' }  — log and exit 1
 *
 * Policy: asymmetric. Code-without-docs is a hard fail (operators can't find
 * the knob, which is the dangerous direction). Docs-without-code is a warn
 * (annoying, not dangerous — and the docs sometimes intentionally mention
 * non-existent names, e.g. "Other STRATOSORT_GRAPH_* names may appear in
 * older docs; they are not read by the codebase").
 *
 * @param {{ name: string, inCode: boolean, inDocs: boolean }} gap
 * @returns {{ status: 'ok' | 'warn' | 'fail', message?: string }}
 */
function classifyGap({ name, inCode, inDocs }, codeNames = new Set()) {
  if (inCode && !inDocs) {
    return {
      status: 'fail',
      message: `${name} is referenced in src/ or scripts/ but missing from docs/CONFIG.md`
    };
  }
  if (!inCode && inDocs) {
    // Family-prefix entries: docs sometimes use a trailing-underscore name
    // (e.g. STRATOSORT_GRAPH_) as a placeholder for a group of related vars
    // (STRATOSORT_GRAPH_ENABLED, STRATOSORT_GRAPH_PATH, …). If any code
    // name starts with this prefix, treat the doc entry as referenced rather
    // than spamming a stale-docs warning every CI run.
    if (name.endsWith('_')) {
      for (const candidate of codeNames) {
        if (candidate.startsWith(name)) {
          return { status: 'ok' };
        }
      }
    }
    return {
      status: 'warn',
      message: `${name} is documented but no longer referenced in src/ or scripts/ (stale docs?)`
    };
  }
  return { status: 'ok' };
}

function main() {
  const code = loadCodeRefs();
  const docs = loadDocMentions();
  const allNames = new Set([...code, ...docs]);

  let failures = 0;
  let warnings = 0;

  for (const name of [...allNames].sort()) {
    const gap = { name, inCode: code.has(name), inDocs: docs.has(name) };
    const result = classifyGap(gap, code);
    if (result.status === 'fail') {
      console.error(`FAIL: ${result.message}`);
      failures += 1;
    } else if (result.status === 'warn') {
      console.warn(`WARN: ${result.message}`);
      warnings += 1;
    }
  }

  console.log(
    `\nverify:env-docs: ${code.size} in code, ${docs.size} in docs, ${failures} failures, ${warnings} warnings.`
  );
  if (failures > 0) process.exit(1);
}

main();
