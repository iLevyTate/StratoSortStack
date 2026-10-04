#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { STABILITY_THRESHOLDS } = require('../../src/shared/performanceConstants');

const repoRoot = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value = 'true'] = token.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getJourneyMap(report) {
  const map = new Map();
  for (const journey of report.journeys || []) {
    map.set(journey.id, journey);
  }
  return map;
}

function validateSmokeThresholds(baselineReport, targetReport) {
  const errors = [];
  const baseline = getJourneyMap(baselineReport);
  const target = getJourneyMap(targetReport);
  const journeyIds = new Set([...baseline.keys(), ...target.keys()]);

  for (const id of journeyIds) {
    const prior = baseline.get(id);
    const current = target.get(id);

    if (!current) {
      if (prior?.required) {
        errors.push(`Required journey missing from target: ${prior.label}`);
      }
      if (prior?.status === 'passed') {
        errors.push(`Regression detected: ${prior.label} missing from target report`);
      }
      continue;
    }

    if (current.required && current.status !== 'passed') {
      errors.push(`Required journey failed in target: ${current.label} (${current.status})`);
    }

    if (prior && prior.status === 'passed' && current.status !== 'passed') {
      errors.push(`Regression detected: ${current.label} passed in baseline but not in target`);
    }

    if (prior && prior.status === 'passed' && current.status === 'passed') {
      const durationGrowth =
        prior.durationMs > 0 ? (current.durationMs - prior.durationMs) / prior.durationMs : 0;
      if (durationGrowth >= 0.5) {
        errors.push(
          `Latency regression >=50% in ${current.label} (${prior.durationMs}ms -> ${current.durationMs}ms)`
        );
      }
    }
  }

  return errors;
}

function validateTelemetryThresholds(targetMetrics, baselineMetrics = null) {
  const errors = [];
  const targetSearchFallbackRate = Number(targetMetrics?.stability?.search?.fallbackRate || 0);
  const targetUncategorizedRate = Number(
    targetMetrics?.stability?.organization?.uncategorizedRate || 0
  );

  if (targetSearchFallbackRate > STABILITY_THRESHOLDS.SEARCH_FALLBACK_RATE_WARN) {
    errors.push(
      `Search fallback rate ${targetSearchFallbackRate.toFixed(3)} exceeds threshold ${STABILITY_THRESHOLDS.SEARCH_FALLBACK_RATE_WARN}`
    );
  }
  if (targetUncategorizedRate > STABILITY_THRESHOLDS.UNCATEGORIZED_ROUTING_RATE_WARN) {
    errors.push(
      `Uncategorized routing rate ${targetUncategorizedRate.toFixed(3)} exceeds threshold ${STABILITY_THRESHOLDS.UNCATEGORIZED_ROUTING_RATE_WARN}`
    );
  }

  if (baselineMetrics) {
    const baselineSearchFallbackRate = Number(
      baselineMetrics?.stability?.search?.fallbackRate || 0
    );
    const baselineUncategorizedRate = Number(
      baselineMetrics?.stability?.organization?.uncategorizedRate || 0
    );

    if (targetSearchFallbackRate > baselineSearchFallbackRate + 0.05) {
      errors.push(
        `Search fallback rate regressed by more than 0.05 (${baselineSearchFallbackRate.toFixed(3)} -> ${targetSearchFallbackRate.toFixed(3)})`
      );
    }
    if (targetUncategorizedRate > baselineUncategorizedRate + 0.05) {
      errors.push(
        `Uncategorized routing rate regressed by more than 0.05 (${baselineUncategorizedRate.toFixed(3)} -> ${targetUncategorizedRate.toFixed(3)})`
      );
    }
  }

  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineReportPath = path.resolve(
    args['baseline-report'] || path.join(repoRoot, '.tmp', 'stability', 'baseline-smoke.json')
  );
  const targetReportPath = path.resolve(
    args['target-report'] || path.join(repoRoot, '.tmp', 'stability', 'target-smoke.json')
  );
  const baselineMetricsPath = args['baseline-metrics']
    ? path.resolve(args['baseline-metrics'])
    : null;
  const targetMetricsPath = args['target-metrics'] ? path.resolve(args['target-metrics']) : null;

  if (!fs.existsSync(baselineReportPath) || !fs.existsSync(targetReportPath)) {
    console.error('Missing smoke reports for threshold check.');
    console.error(`Baseline: ${baselineReportPath}`);
    console.error(`Target: ${targetReportPath}`);
    process.exit(1);
  }

  const baselineReport = readJson(baselineReportPath);
  const targetReport = readJson(targetReportPath);
  const errors = validateSmokeThresholds(baselineReport, targetReport);

  if (targetMetricsPath && fs.existsSync(targetMetricsPath)) {
    const targetMetrics = readJson(targetMetricsPath);
    const baselineMetrics =
      baselineMetricsPath && fs.existsSync(baselineMetricsPath)
        ? readJson(baselineMetricsPath)
        : null;
    errors.push(...validateTelemetryThresholds(targetMetrics, baselineMetrics));
  }

  if (errors.length > 0) {
    console.error('\nRelease threshold check failed:\n');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('OK: Release thresholds satisfied.');
}

if (require.main === module) {
  main();
}

module.exports = {
  validateSmokeThresholds,
  validateTelemetryThresholds,
  getJourneyMap
};
