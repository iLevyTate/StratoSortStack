#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildCommercialComplianceReport, repoRoot } = require('./commercial-compliance-lib');

const OUTPUT_PATH = path.join(repoRoot, 'docs', 'commercial-use-inventory.json');

function main() {
  const report = buildCommercialComplianceReport();
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const dependencySummary = report.dependencySummary;
  const modelSummary = report.modelSummary;

  console.log('Commercial compliance inventory generated.');
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log(
    `  Dependencies -> allowed: ${dependencySummary.allowed}, review_required: ${dependencySummary.review_required}, high_risk: ${dependencySummary.high_risk}, unknown: ${dependencySummary.unknown}`
  );
  console.log(
    `  Models -> allowed: ${modelSummary.allowed}, review_required: ${modelSummary.review_required}, high_risk: ${modelSummary.high_risk}, unknown: ${modelSummary.unknown}`
  );
}

try {
  main();
} catch (error) {
  console.error(`Failed to build commercial compliance report: ${error.message}`);
  process.exit(1);
}
