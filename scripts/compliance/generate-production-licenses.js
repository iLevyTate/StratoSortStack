#!/usr/bin/env node

/**
 * Generate docs/licenses-production.json: the license of every package that ships
 * in the installer, derived from package-lock.json through the same inventory the
 * commercial-compliance gate uses. "Ships" means not `dev: true` in the lockfile,
 * or part of the BUNDLED_RENDERER_DEPS closure that webpack compiles into the
 * renderer bundle — so this report and `compliance:commercial:verify` can never
 * disagree about what is distributed.
 */

const fs = require('fs');
const path = require('path');
const { buildCommercialComplianceReport, repoRoot } = require('./commercial-compliance-lib');

const OUTPUT_PATH = path.join(repoRoot, 'docs', 'licenses-production.json');

function isShipped(dep) {
  return !dep.lockfileDev || dep.bundledRenderer === true;
}

function buildProductionLicenses(report) {
  const packages = {};
  for (const dep of report.dependencies.filter(isShipped)) {
    const entry = { license: dep.license, riskLevel: dep.riskLevel };
    if (dep.lockfileOptional) entry.optional = true;
    if (dep.bundledRenderer) entry.bundledRenderer = true;
    if (dep.licenseManualSource) entry.licenseManualSource = dep.licenseManualSource;
    packages[`${dep.packageName}@${dep.version}`] = entry;
  }
  return { generatedAt: report.generatedAt, source: 'package-lock.json', packages };
}

function main() {
  const output = buildProductionLicenses(buildCommercialComplianceReport());
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${Object.keys(output.packages).length} shipped package licenses to ${path.relative(repoRoot, OUTPUT_PATH)}`
  );
}

module.exports = { buildProductionLicenses, isShipped };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Failed to generate production licenses: ${error.message}`);
    process.exit(1);
  }
}
