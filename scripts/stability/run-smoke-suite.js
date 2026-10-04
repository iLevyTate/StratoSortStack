#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SMOKE_JOURNEYS } = require('./smokeSuiteConfig');

const repoRoot = path.resolve(__dirname, '../..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value = 'true'] = token.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function extractCounts(output) {
  const text = String(output || '');
  const suitesMatch = text.match(/Test Suites:\s+([^\n]+)/i);
  const testsMatch = text.match(/Tests:\s+([^\n]+)/i);
  return {
    suites: suitesMatch ? suitesMatch[1].trim() : null,
    tests: testsMatch ? testsMatch[1].trim() : null
  };
}

function tailText(text, maxLen) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;
  return s.slice(-maxLen);
}

function hasLocalJest(modulesDir) {
  if (fs.existsSync(path.join(modulesDir, 'jest', 'package.json'))) {
    return true;
  }
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(modulesDir, '.bin', 'jest.cmd'));
  }
  return fs.existsSync(path.join(modulesDir, '.bin', 'jest'));
}

function runJourney(projectRoot, journey) {
  const discoveredTests = journey.tests.filter((testPath) =>
    fs.existsSync(path.join(projectRoot, testPath))
  );
  const missingTests = journey.tests.filter(
    (testPath) => !fs.existsSync(path.join(projectRoot, testPath))
  );

  if (discoveredTests.length === 0) {
    return {
      id: journey.id,
      label: journey.label,
      required: Boolean(journey.required),
      status: 'missing',
      success: false,
      durationMs: 0,
      discoveredTests,
      missingTests,
      outputSummary: 'No smoke tests found for this journey in target ref.'
    };
  }

  const configPath = path.join(projectRoot, 'test', 'jest.config.js');
  const absoluteTests = discoveredTests.map((testPath) => path.join(projectRoot, testPath));
  const startedAt = Date.now();
  const result = spawnSync(
    npmCmd,
    [
      'exec',
      '--',
      'jest',
      '--runTestsByPath',
      '--config',
      configPath,
      '--runInBand',
      '--no-coverage',
      ...absoluteTests
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: process.env
    }
  );
  const durationMs = Date.now() - startedAt;
  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const counts = extractCounts(combinedOutput);
  const exitOk = !result.error && result.status === 0;

  const entry = {
    id: journey.id,
    label: journey.label,
    required: Boolean(journey.required),
    status: exitOk ? 'passed' : 'failed',
    success: exitOk,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    durationMs,
    discoveredTests,
    missingTests,
    outputSummary: {
      suites: counts.suites,
      tests: counts.tests
    }
  };
  if (!exitOk) {
    entry.spawnError = result.error ? String(result.error.message || result.error) : null;
    entry.outputTail = tailText(combinedOutput, 6000);
  }
  return entry;
}

function summarize(report) {
  const requiredJourneys = report.journeys.filter((entry) => entry.required);
  const requiredFailures = requiredJourneys.filter((entry) => !entry.success).length;
  const missingRequired = requiredJourneys.filter((entry) => entry.status === 'missing').length;

  report.summary = {
    totalJourneys: report.journeys.length,
    requiredJourneys: requiredJourneys.length,
    passedJourneys: report.journeys.filter((entry) => entry.success).length,
    failedJourneys: report.journeys.filter((entry) => entry.status === 'failed').length,
    missingJourneys: report.journeys.filter((entry) => entry.status === 'missing').length,
    missingRequiredJourneys: missingRequired,
    success: requiredFailures === 0 && missingRequired === 0
  };

  return report;
}

function getGitSha(projectRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(args['project-root'] || repoRoot);
  const label = args.label || path.basename(projectRoot);
  const allowFailures = args['allow-failures'] === 'true';
  const outputPath = path.resolve(
    args.output || path.join(repoRoot, '.tmp', 'stability', `${label}-smoke.json`)
  );
  const modulesDir = path.join(projectRoot, 'node_modules');
  if (!hasLocalJest(modulesDir)) {
    console.error(
      `Jest is not available under ${modulesDir}. ` +
        'Run npm install at the repository root or ensure compare-baseline linked node_modules into the worktree.'
    );
    process.exit(1);
  }
  if (!fs.existsSync(path.join(projectRoot, 'test', 'jest.config.js'))) {
    console.error(`Could not find Jest config in ${projectRoot}`);
    process.exit(1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    label,
    projectRoot,
    gitSha: getGitSha(projectRoot),
    journeys: []
  };

  for (const journey of SMOKE_JOURNEYS) {
    const journeyResult = runJourney(projectRoot, journey);
    report.journeys.push(journeyResult);
    const statusTag = journeyResult.success ? 'PASS' : 'FAIL';
    console.log(
      `[${statusTag}] ${journey.label} (${Math.round(journeyResult.durationMs / 1000)}s) - ${journeyResult.status}`
    );
  }

  summarize(report);
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nSmoke report written to ${outputPath}`);
  if (!report.summary.success && !allowFailures) {
    process.exit(1);
  }
}

main();
