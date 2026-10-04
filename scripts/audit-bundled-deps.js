#!/usr/bin/env node

/**
 * `npm audit --omit=dev` (audit:production) skips every lockfile `dev: true`
 * package — including the renderer libraries webpack bundles into the shipped
 * app. This gate runs the full `npm audit --json` and fails on high/critical
 * advisories whose affected nodes fall inside the BUNDLED_RENDERER_DEPS closure.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  repoRoot,
  resolveBundledRendererClosure
} = require('./compliance/commercial-compliance-lib');

const FAILING_SEVERITIES = new Set(['high', 'critical']);

/**
 * @param {{ vulnerabilities?: Record<string, { severity: string, nodes?: string[], range?: string, via?: unknown[] }> }} auditJson
 * @param {Set<string>} bundledPaths lockfile paths in the bundled closure
 */
function findBundledAdvisories(auditJson, bundledPaths, failingSeverities = FAILING_SEVERITIES) {
  const findings = [];
  for (const [name, vuln] of Object.entries(auditJson.vulnerabilities || {})) {
    if (!failingSeverities.has(vuln.severity)) continue;
    const bundledNodes = (vuln.nodes || []).filter((node) => bundledPaths.has(node));
    if (bundledNodes.length === 0) continue;
    const advisories = (vuln.via || [])
      .filter((v) => typeof v === 'object' && v !== null)
      .map((v) => v.url || v.title)
      .filter(Boolean);
    findings.push({
      name,
      severity: vuln.severity,
      range: vuln.range,
      nodes: bundledNodes,
      advisories
    });
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name));
}

function runNpmAudit() {
  // `npm audit` exits non-zero whenever any vulnerability exists (dev included),
  // so only a missing/unparseable report is treated as a tooling failure here.
  const result = spawnSync('npm audit --json', {
    cwd: repoRoot,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit produced no JSON report:\n${result.stderr || result.stdout}`);
  }
}

function main() {
  const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const bundledPaths = resolveBundledRendererClosure(packageLock);
  const findings = findBundledAdvisories(runNpmAudit(), bundledPaths);

  if (findings.length > 0) {
    console.error('Bundled renderer dependency audit failed (high/critical advisories):');
    for (const f of findings) {
      console.error(`  - ${f.name} ${f.range} [${f.severity}] via ${f.nodes.join(', ')}`);
      for (const advisory of f.advisories) console.error(`      ${advisory}`);
    }
    process.exit(1);
  }
  console.log(
    `Bundled renderer dependency audit passed (${bundledPaths.size} packages in the webpack closure).`
  );
}

module.exports = { FAILING_SEVERITIES, findBundledAdvisories };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Bundled renderer dependency audit failed: ${error.message}`);
    process.exit(1);
  }
}
