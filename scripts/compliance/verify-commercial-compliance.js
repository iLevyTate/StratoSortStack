#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildCommercialComplianceReport, repoRoot } = require('./commercial-compliance-lib');

const WAIVERS_PATH = path.join(repoRoot, 'docs', 'commercial-compliance-waivers.json');
const REPORT_PATH = path.join(repoRoot, 'docs', 'commercial-use-inventory.json');

function defaultWaivers() {
  return {
    dependencies: { high_risk: [], unknown: [] },
    models: { high_risk: [], unknown: [] }
  };
}

function readWaivers() {
  if (!fs.existsSync(WAIVERS_PATH)) {
    return defaultWaivers();
  }
  return {
    ...defaultWaivers(),
    ...JSON.parse(fs.readFileSync(WAIVERS_PATH, 'utf8'))
  };
}

function isWaived(set, value) {
  return Array.isArray(set) && set.includes(value);
}

function collectFailures(report, waivers) {
  const failures = [];
  const depHighRiskWaivers = waivers.dependencies?.high_risk || [];
  const depUnknownWaivers = waivers.dependencies?.unknown || [];
  const modelHighRiskWaivers = waivers.models?.high_risk || [];
  const modelUnknownWaivers = waivers.models?.unknown || [];

  for (const dep of report.dependencies || []) {
    // Dev-only packages (lockfile `dev: true`) are not copied into the shipped
    // installer, so they cannot create a redistribution obligation — except the
    // BUNDLED_RENDERER_DEPS closure, which webpack compiles into the renderer
    // bundle (`bundledRenderer: true`) and is therefore gated. Optional
    // packages (lockfile `optional: true`) are platform-specific binary
    // variants (e.g. *-linux-x64-musl shards of lz4-napi/sharp) that
    // electron-builder selects per target platform; they are reported in the
    // inventory but not gated here.
    if ((dep.lockfileDev && !dep.bundledRenderer) || dep.lockfileOptional) continue;

    if (dep.riskLevel === 'high_risk' && !isWaived(depHighRiskWaivers, dep.packageName)) {
      failures.push({
        category: 'dependencies',
        riskLevel: 'high_risk',
        name: dep.packageName
      });
    }
    if (dep.riskLevel === 'unknown' && !isWaived(depUnknownWaivers, dep.packageName)) {
      failures.push({
        category: 'dependencies',
        riskLevel: 'unknown',
        name: dep.packageName
      });
    }
  }

  for (const model of report.models || []) {
    const key = model.artifactName;
    if (model.riskLevel === 'high_risk' && !isWaived(modelHighRiskWaivers, key)) {
      failures.push({
        category: 'models',
        riskLevel: 'high_risk',
        name: key
      });
    }
    if (model.riskLevel === 'unknown' && !isWaived(modelUnknownWaivers, key)) {
      failures.push({
        category: 'models',
        riskLevel: 'unknown',
        name: key
      });
    }
  }

  return failures;
}

function summarizeUnwaivedItems(failures) {
  return failures.map((failure) => `${failure.category}.${failure.riskLevel}: ${failure.name}`);
}

function evaluateCommercialCompliance(report, waivers) {
  const failures = collectFailures(report, waivers);
  return {
    ok: failures.length === 0,
    failures
  };
}

function writeReportFile(report) {
  const next = `${JSON.stringify(report, null, 2)}\n`;
  // Skip the write when nothing but generatedAt changed — every `npm run ci`
  // was rewriting the committed inventory with a fresh timestamp, leaving
  // permanent working-tree churn.
  try {
    const prev = fs.readFileSync(REPORT_PATH, 'utf8');
    const strip = (s) => s.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
    if (strip(prev) === strip(next)) return;
  } catch {
    // Missing/unreadable previous report: fall through and write.
  }
  fs.writeFileSync(REPORT_PATH, next, 'utf8');
}

function verifyCommercialCompliance(options = {}) {
  const report = options.report || buildCommercialComplianceReport();
  const waivers = options.waivers || readWaivers();
  if (options.writeReport) {
    writeReportFile(report);
  }
  return {
    report,
    waivers,
    ...evaluateCommercialCompliance(report, waivers)
  };
}

function main(argv = process.argv.slice(2)) {
  const writeReport = argv.includes('--write-report');
  const result = verifyCommercialCompliance({ writeReport });

  if (!result.ok) {
    console.error('Commercial compliance verification failed.');
    for (const failure of summarizeUnwaivedItems(result.failures)) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log('Commercial compliance verification passed.');
  console.log(
    `  Dependency summary: ${JSON.stringify(result.report.dependencySummary)} | Model summary: ${JSON.stringify(result.report.modelSummary)}`
  );
}

module.exports = {
  collectFailures,
  evaluateCommercialCompliance,
  main,
  readWaivers,
  summarizeUnwaivedItems,
  verifyCommercialCompliance,
  writeReportFile
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Commercial compliance verification failed: ${error.message}`);
    process.exit(1);
  }
}
