#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

function runGit(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim() || 'git command failed';
    throw new Error(`git ${args.join(' ')}: ${message}`);
  }
  return String(result.stdout || '').trim();
}

function tryRunGit(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function resolveBaselineRef(targetRef) {
  const exactTag = tryRunGit(['describe', '--tags', '--exact-match', targetRef]);
  const mergedTagsOutput = runGit(['tag', '--merged', targetRef, '--sort=-version:refname']);
  const mergedTags = mergedTagsOutput
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));

  const baselineTag = mergedTags.find((tag) => tag !== exactTag);
  if (!baselineTag) {
    throw new Error(`Unable to resolve a baseline tag prior to target '${targetRef}'.`);
  }
  return baselineTag;
}

function readJson(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(raw);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function summarizeDiffByBucket(baselineRef, targetRef) {
  const output = runGit(['diff', '--numstat', `${baselineRef}..${targetRef}`]);
  const rows = output.split(/\r?\n/).filter(Boolean);
  const buckets = new Map();

  const getBucket = (filePath) => {
    if (filePath.startsWith('src/')) return 'src';
    if (filePath.startsWith('test/')) return 'test';
    if (filePath.startsWith('docs/')) return 'docs';
    if (filePath.startsWith('.github/')) return 'ci';
    return 'other';
  };

  for (const row of rows) {
    const [addRaw, delRaw, filePath] = row.split('\t');
    if (!filePath) continue;
    const add = addRaw === '-' ? 0 : Number(addRaw);
    const del = delRaw === '-' ? 0 : Number(delRaw);
    const bucket = getBucket(filePath);
    const current = buckets.get(bucket) || { files: 0, added: 0, deleted: 0 };
    current.files += 1;
    current.added += Number.isFinite(add) ? add : 0;
    current.deleted += Number.isFinite(del) ? del : 0;
    buckets.set(bucket, current);
  }

  return Array.from(buckets.entries())
    .map(([name, data]) => ({ name, ...data, net: data.added - data.deleted }))
    .sort((a, b) => b.net - a.net);
}

function getTopTouchedFiles(baselineRef, targetRef, topN = 10) {
  const output = runGit(['log', '--name-only', '--pretty=format:', `${baselineRef}..${targetRef}`]);
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const file = line.trim();
    if (!file) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

function mapByJourney(report) {
  const map = new Map();
  for (const journey of report.journeys || []) {
    map.set(journey.id, journey);
  }
  return map;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildJourneyRows(baselineReport, targetReport) {
  const baseline = mapByJourney(baselineReport);
  const target = mapByJourney(targetReport);
  const ids = new Set([...baseline.keys(), ...target.keys()]);

  return Array.from(ids).map((id) => {
    const b = baseline.get(id);
    const t = target.get(id);
    const baselineStatus = b?.status || 'missing';
    const targetStatus = t?.status || 'missing';
    const baselineDuration = b?.durationMs || 0;
    const targetDuration = t?.durationMs || 0;

    let outcome = 'stable';
    if (baselineStatus === 'passed' && targetStatus !== 'passed') outcome = 'regressed';
    if (baselineStatus !== 'passed' && targetStatus === 'passed') outcome = 'improved';

    return {
      id,
      label: t?.label || b?.label || id,
      baselineStatus,
      targetStatus,
      baselineDuration,
      targetDuration,
      outcome
    };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetRef = args.target || 'HEAD';
  const baselineRef = args.baseline || resolveBaselineRef(targetRef);
  const baselineReportPath = path.resolve(
    args['baseline-report'] || path.join(repoRoot, '.tmp', 'stability', 'baseline-smoke.json')
  );
  const targetReportPath = path.resolve(
    args['target-report'] || path.join(repoRoot, '.tmp', 'stability', 'target-smoke.json')
  );
  const outputPath = path.resolve(
    args.output || path.join(repoRoot, 'docs', 'STABILITY_BASELINE_LEDGER.md')
  );

  if (!fs.existsSync(baselineReportPath)) {
    throw new Error(`Missing baseline smoke report: ${baselineReportPath}`);
  }
  if (!fs.existsSync(targetReportPath)) {
    throw new Error(`Missing target smoke report: ${targetReportPath}`);
  }

  const baselineReport = readJson(baselineReportPath);
  const targetReport = readJson(targetReportPath);

  const commitCount = runGit(['rev-list', '--count', `${baselineRef}..${targetRef}`]);
  const diffStat = runGit(['diff', '--shortstat', `${baselineRef}..${targetRef}`]);
  const bucketStats = summarizeDiffByBucket(baselineRef, targetRef);
  const topTouched = getTopTouchedFiles(baselineRef, targetRef, 8);
  const journeyRows = buildJourneyRows(baselineReport, targetReport);

  const keepItems = journeyRows
    .filter((row) => row.targetStatus === 'passed')
    .map((row) => {
      const faster = row.targetDuration < row.baselineDuration;
      const durationText =
        row.baselineDuration > 0
          ? `${formatDuration(row.baselineDuration)} -> ${formatDuration(row.targetDuration)}`
          : formatDuration(row.targetDuration);
      return `- ${row.label}: PASS (${durationText})${faster ? ' (improved)' : ''}`;
    });

  const fixItems = journeyRows
    .filter((row) => row.targetStatus !== 'passed')
    .map(
      (row) =>
        `- ${row.label}: ${row.baselineStatus.toUpperCase()} -> ${row.targetStatus.toUpperCase()}`
    );

  const rollbackCandidates = topTouched
    .slice(0, 5)
    .map((entry) => `- \`${entry.file}\` (${entry.count} touches in range)`);

  const bucketLines = bucketStats.map(
    (bucket) =>
      `- ${bucket.name}: files=${bucket.files}, +${bucket.added}, -${bucket.deleted}, net=${bucket.net}`
  );

  const markdown = [
    '# Stability Baseline Ledger',
    '',
    `- Baseline ref: \`${baselineRef}\` (\`${baselineReport.gitSha || 'unknown'}\`)`,
    `- Target ref: \`${targetRef}\` (\`${targetReport.gitSha || 'unknown'}\`)`,
    `- Compared at: ${new Date().toISOString()}`,
    '',
    '## Scope Snapshot',
    '',
    `- Commits since baseline: ${commitCount}`,
    `- Diff summary: ${diffStat || 'n/a'}`,
    ...bucketLines,
    '',
    '## Smoke Suite Results',
    '',
    '| Journey | Baseline | Target | Baseline Duration | Target Duration |',
    '|---|---|---|---:|---:|',
    ...journeyRows.map(
      (row) =>
        `| ${row.label} | ${row.baselineStatus} | ${row.targetStatus} | ${formatDuration(row.baselineDuration)} | ${formatDuration(row.targetDuration)} |`
    ),
    '',
    '## Keep',
    '',
    ...(keepItems.length > 0 ? keepItems : ['- No keep candidates identified.']),
    '',
    '## Fix',
    '',
    ...(fixItems.length > 0 ? fixItems : ['- No immediate regressions detected in smoke suite.']),
    '',
    '## Rollback Candidates (Highest Churn / Lowest Confidence)',
    '',
    ...rollbackCandidates,
    '',
    '## Notes',
    '',
    '- Rollback candidates are identified by churn concentration, not automatic rollback decisions.',
    '- Keep/Fix/Rollback decisions should still be reviewed with product impact and telemetry.'
  ].join('\n');

  ensureDir(outputPath);
  fs.writeFileSync(outputPath, `${markdown}\n`, 'utf8');
  console.log(`Wrote baseline ledger: ${outputPath}`);
}

main();
