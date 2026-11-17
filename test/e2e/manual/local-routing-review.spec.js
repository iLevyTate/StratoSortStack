/**
 * Local-model routing review: small Search Console exports and their folder.
 *
 * A tester's 5.4.0 run held most of their Google Search Console exports for
 * review: small tables score low against a folder whose embedding comes from
 * its name and description only. This spec rebuilds that case with the local
 * models and reports, for each folder description below, where each file
 * would go, its score, whether it is held, and the folder it came closest to
 * (what the uncategorized bar now offers in one click). It ends with a Chat
 * question about the exports, timed.
 *
 * It asserts only that the pipeline ran; the numbers are the point. The
 * report goes to test-results/local-routing-review/.
 *
 * Run (Windows, from the repo root, after `npm run build`):
 *   $env:STRATOSORT_E2E_ROUTING_REVIEW='1'
 *   $env:STRATOSORT_E2E_MODELS_DIR="$env:APPDATA\StratoSort Stack\models"
 *   npx playwright test test/e2e/manual/local-routing-review.spec.js --retries=0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs/promises');
const XlsxPopulate = require('xlsx-populate');
const { launchApp, closeApp, waitForAppReady } = require('../helpers/electronApp');
const { createTempDir, cleanupTempDir } = require('../helpers/testFixtures');
const {
  waitForLoadedTextModel,
  normalizeAnalysisPayload,
  waitForFileInSearch
} = require('../helpers/liveLlm');

const ENABLED = process.env.STRATOSORT_E2E_ROUTING_REVIEW === '1';
const REPORT_DIR = path.join(__dirname, '..', '..', '..', 'test-results', 'local-routing-review');

const SITE = 'https://example-prompts.com';
const GSC_FOLDER = 'excel GSc';

// The same folder, described three ways a user might.
const GSC_DESCRIPTIONS = [
  { key: 'name-only', description: '' },
  { key: 'short', description: 'Spreadsheets from Google Search Console' },
  {
    key: 'full',
    description:
      'Google Search Console performance exports for our website: spreadsheets of search ' +
      'queries, pages, countries, devices and dates with clicks, impressions, CTR and ' +
      'average position.'
  }
];

const OTHER_FOLDERS = [
  { name: 'Invoices', description: 'Bills and invoices from vendors and suppliers' },
  { name: 'Marketing', description: 'Marketing plans, campaign briefs and budgets' },
  { name: 'Meeting notes', description: 'Notes and minutes from team meetings' }
];

const HEADER = ['Clicks', 'Impressions', 'CTR', 'Position'];

/** Deterministic rows: [label, clicks, impressions, ctr, position]. */
let corpusVariant = 0;

function metricRows(labels, baseSeed) {
  const seed = baseSeed + corpusVariant * 100;
  return labels.map((label, i) => {
    const impressions = 40 + ((seed * 37 + i * 53) % 900);
    const clicks = Math.max(0, Math.round(impressions * (0.01 + ((seed + i) % 7) / 100)));
    const ctr = `${((clicks / impressions) * 100).toFixed(2)}%`;
    const position = Number((2 + ((seed * 3 + i * 5) % 40) / 3).toFixed(1));
    return [label, clicks, impressions, ctr, position];
  });
}

const QUERIES = [
  'prompt engineering examples',
  'compare llm answers',
  'best prompt for summaries',
  'chatgpt vs claude prompts',
  'prompt templates free',
  'how to write system prompts',
  'llm prompt testing tool',
  'prompt quorum voting',
  'few shot prompt examples',
  'prompt library'
];
const PAGES = ['/', '/blog/prompt-patterns', '/tools/compare', '/pricing', '/docs/getting-started'];
const COUNTRIES = ['United States', 'Germany', 'United Kingdom', 'India', 'Canada'];
const DEVICES = ['Desktop', 'Mobile', 'Tablet'];
const DATES = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);

/** @param {string} file @param {Array<{ name: string, title: string, rows: any[][] }>} sheets */
async function writeWorkbook(file, sheets) {
  const book = await XlsxPopulate.fromBlankAsync();
  sheets.forEach((sheet, index) => {
    const ws = index === 0 ? book.sheet(0).name(sheet.name) : book.addSheet(sheet.name);
    ws.cell('A1').value([[sheet.title, ...HEADER], ...sheet.rows]);
  });
  await book.toFileAsync(file);
}

/** The tester's case: exports of one site, from one full export down to 3-row tables. */
async function buildCorpus(dir, variant = 0) {
  corpusVariant = variant;
  const files = [];
  const add = (name, expected) => {
    const file = path.join(dir, name);
    files.push({ path: file, name, expected });
    return file;
  };

  await writeWorkbook(add('example-prompts.com-Performance-on-Search-2026-10.xlsx', GSC_FOLDER), [
    { name: 'Queries', title: 'Top queries', rows: metricRows(QUERIES, 1) },
    {
      name: 'Pages',
      title: 'Top pages',
      rows: metricRows(
        PAGES.map((p) => SITE + p),
        2
      )
    },
    { name: 'Countries', title: 'Country', rows: metricRows(COUNTRIES, 3) },
    { name: 'Devices', title: 'Device', rows: metricRows(DEVICES, 4) },
    { name: 'Dates', title: 'Date', rows: metricRows(DATES, 5) }
  ]);
  await writeWorkbook(add('gsc-queries-week44.xlsx', GSC_FOLDER), [
    { name: 'Queries', title: 'Top queries', rows: metricRows(QUERIES.slice(0, 8), 6) }
  ]);
  await writeWorkbook(add('gsc-pages-oct.xlsx', GSC_FOLDER), [
    {
      name: 'Pages',
      title: 'Top pages',
      rows: metricRows(
        PAGES.map((p) => SITE + p),
        7
      )
    }
  ]);
  await writeWorkbook(add('gsc-countries.xlsx', GSC_FOLDER), [
    { name: 'Countries', title: 'Country', rows: metricRows(COUNTRIES, 8) }
  ]);
  await writeWorkbook(add('gsc-devices.xlsx', GSC_FOLDER), [
    { name: 'Devices', title: 'Device', rows: metricRows(DEVICES, 9) }
  ]);
  await writeWorkbook(add('search-console-dates.xlsx', GSC_FOLDER), [
    { name: 'Dates', title: 'Date', rows: metricRows(DATES, 10) }
  ]);

  // Files that belong elsewhere, so a folder that takes everything shows up.
  const invoice = await XlsxPopulate.fromBlankAsync();
  invoice
    .sheet(0)
    .name('Invoice')
    .cell('A1')
    .value([
      ['Invoice #', 'INV-0412'],
      ['Vendor', 'Northwind Office Supply'],
      ['Due date', '2026-11-30'],
      ['Item', 'Qty', 'Unit price', 'Total'],
      ['Printer paper (case)', 4, 38.5, 154],
      ['Toner cartridge', 2, 89, 178],
      ['Subtotal', '', '', 332],
      ['Tax', '', '', 26.56],
      ['Amount due', '', '', 358.56]
    ]);
  await invoice.toFileAsync(add('invoice-northwind-0412.xlsx', 'Invoices'));

  await fs.writeFile(
    add('q4-marketing-plan.txt', 'Marketing'),
    [
      'Q4 marketing plan',
      '',
      'Goal: grow newsletter sign-ups 20% before the holidays.',
      'Campaigns: two webinars, a holiday discount email series, and paid social in December.',
      'Budget: $12,000, split 60% paid social and 40% email and webinars.',
      'Owner: marketing lead. Review every two weeks.',
      `Plan copy ${variant + 1}.`
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(
    add('team-meeting-2026-11-03.txt', 'Meeting notes'),
    [
      'Team meeting, 3 November 2026',
      '',
      'Attendees: product, design, support.',
      'Decisions: ship the onboarding checklist next sprint; move the pricing page test to December.',
      'Action items: design to share mockups Friday; support to collect five customer quotes.',
      `Notes copy ${variant + 1}.`
    ].join('\n'),
    'utf8'
  );
  return files;
}

// The fields Organize's ranking reads (toSuggestionFile in useOrganizeSuggestions).
const HEAVY_ANALYSIS_KEYS = [
  'extractedText',
  'ocrText',
  'transcript',
  'transcriptSegments',
  'keyframes',
  'embedding',
  'chunks'
];
const RANKING_OPTIONS = {
  includeStructureAnalysis: false,
  skipGeneration: true,
  skipImprovementCandidates: true
};

function toSuggestionFile(file) {
  const analysis = { ...(file.analysis || {}) };
  for (const key of HEAVY_ANALYSIS_KEYS) delete analysis[key];
  return {
    path: file.path,
    name: file.name,
    extension: path.extname(file.name).slice(1),
    analysis
  };
}

const toUnit = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? (value > 1 ? value / 100 : value) : null;

/** One row per file, in the terms the review cards and the bar use. */
function summarizeEntry(entry) {
  const needsReview = entry?.needsReview === true || entry?.suggestion?.needsReview === true;
  const best = entry?.routingDecision?.best || entry?.suggestion?.review?.best || null;
  return {
    folder: entry?.suggestion?.folder || null,
    score: toUnit(entry?.confidence) ?? toUnit(entry?.suggestion?.confidence),
    needsReview,
    reason: entry?.routingDecision?.reason || entry?.suggestion?.review?.reason || null,
    closest: best?.folder || null,
    closestScore: toUnit(best?.score),
    alternatives: (entry?.alternatives || [])
      .slice(0, 3)
      .map((alt) => `${alt?.folder} ${Math.round((toUnit(alt?.confidence) || 0) * 100)}%`)
  };
}

function matchWords(score) {
  if (typeof score !== 'number') return '-';
  const pct = Math.round(score * 100);
  if (pct >= 75) return 'Strong match';
  if (pct >= 55) return 'Good match';
  return 'Check this';
}

async function rank(window, files) {
  const response = await window.evaluate(
    async ({ list, options }) => window.electronAPI.suggestions.getBatchSuggestions(list, options),
    { list: files.map(toSuggestionFile), options: RANKING_OPTIONS }
  );
  const byPath = new Map();
  for (const group of response?.groups || []) {
    for (const entry of group?.files || []) byPath.set(entry?.path, summarizeEntry(entry));
  }
  return { ok: Boolean(response?.success), byPath, error: response?.error || null };
}

async function askChat(window, query, timeoutMs = 240_000) {
  return window.evaluate(
    async ({ query, timeoutMs }) => {
      const chat = window.electronAPI?.chat;
      if (!chat?.queryStream) return { ok: false, reason: 'chat streaming API unavailable' };
      const requestId = `routing-review-${Date.now()}`;
      const chunks = [];
      let end = null;
      let done = null;
      let streamError = null;
      const offChunk = chat.onStreamChunk((data) => {
        if (data?.requestId != null && String(data.requestId) !== requestId) return;
        if (data?.type === 'error') streamError = data.error || 'stream error';
        if (data?.type === 'chunk' && data.text) chunks.push(data.text);
        if (data?.type === 'done') done = data;
      });
      const offEnd = chat.onStreamEnd((data) => {
        if (data?.requestId != null && String(data.requestId) !== requestId) return;
        end = data || {};
      });
      const started = Date.now();
      try {
        const res = await chat.queryStream({
          query,
          requestId,
          sessionId: 'routing-review',
          mode: 'hybrid',
          topK: 6,
          responseMode: 'fast'
        });
        if (!res?.success) return { ok: false, reason: res?.error || 'queryStream did not start' };
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !end && !streamError) {
          await new Promise((r) => setTimeout(r, 250));
        }
        const sources = (done?.sources || end?.sources || [])
          .map((s) => s?.name || s?.fileName || s?.path || '')
          .filter(Boolean);
        const asText = (items) =>
          (Array.isArray(items) ? items : [])
            .map((item) => (typeof item === 'string' ? item : item?.text || ''))
            .filter(Boolean)
            .join(' ');
        const answer =
          chunks.join('').trim() ||
          [asText(done?.response?.documentAnswer), asText(done?.response?.modelAnswer)]
            .filter(Boolean)
            .join('\n\n');
        return {
          ok: Boolean(end) && !streamError,
          reason: streamError || (end ? null : 'timed out'),
          ms: Date.now() - started,
          text: answer,
          sources
        };
      } finally {
        offChunk?.();
        offEnd?.();
      }
    },
    { query, timeoutMs }
  );
}

function renderMarkdown(report) {
  const lines = [`# Local routing review (${report.startedAt})`, ''];
  lines.push(`Text model: ${report.textModel || 'unknown'}`, '');
  lines.push('## Analysis', '', '| File | Label | Seconds |', '| --- | --- | --- |');
  for (const f of report.files) {
    lines.push(`| ${f.name} | ${f.category || f.error || '-'} | ${(f.ms / 1000).toFixed(1)} |`);
  }
  if (report.filesAfter?.length) {
    lines.push('', '## Analysis with the full description in place', '');
    lines.push('| File | Label | Seconds |', '| --- | --- | --- |');
    for (const f of report.filesAfter) {
      lines.push(`| ${f.name} | ${f.category || f.error || '-'} | ${(f.ms / 1000).toFixed(1)} |`);
    }
  }
  for (const c of report.conditions) {
    lines.push('', `## "${GSC_FOLDER}" described: ${c.key}`, '');
    lines.push(`Description: ${c.description || '(none)'}`, '');
    lines.push('| File | Expected | Goes to | Score | Card says | Held | Closest |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of c.rows) {
      const score = typeof row.score === 'number' ? `${Math.round(row.score * 100)}%` : '-';
      const closest = row.closest
        ? `${row.closest} ${Math.round((row.closestScore || 0) * 100)}%`
        : '-';
      lines.push(
        `| ${row.name} | ${row.expected} | ${row.needsReview ? '(held)' : row.folder || '-'} | ` +
          `${score} | ${row.needsReview ? 'held' : matchWords(row.score)} | ` +
          `${row.needsReview ? 'yes' : 'no'} | ${closest} |`
      );
    }
    lines.push('', `Correct: ${c.correct}/${c.rows.length}. Held: ${c.held}.`);
    lines.push(`Bar offer: ${c.barOffer || 'none'}.`);
  }
  if (report.chat) {
    lines.push('', '## Chat', '', `Q: ${report.chat.query}`, '');
    lines.push(`Seconds: ${((report.chat.ms || 0) / 1000).toFixed(1)}. OK: ${report.chat.ok}.`);
    if (report.chat.sources?.length) lines.push(`Sources: ${report.chat.sources.join(', ')}`);
    lines.push('', report.chat.text || report.chat.reason || '(no answer)');
  }
  return lines.join('\n') + '\n';
}

async function analyzeAll(window, corpus, log) {
  for (const file of corpus) {
    const started = Date.now();
    const res = await window.evaluate(async (p) => {
      try {
        return { ok: true, res: await window.electronAPI.analysis.document(p) };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }, file.path);
    file.analysis = res.ok ? normalizeAnalysisPayload(res.res) : null;
    log.push({
      name: file.name,
      ms: Date.now() - started,
      category: file.analysis?.category || null,
      error: res.ok ? (file.analysis?.error ?? null) : res.error
    });
    console.log(`[routing-review] analyzed ${file.name} in ${Date.now() - started} ms`);
  }
  return corpus.filter((f) => f.analysis);
}

const signature = (ranked) =>
  JSON.stringify([...ranked.byPath.values()].map((v) => [v.folder, v.score, v.alternatives]));

/** Rank, waiting up to 60 s for an edited folder's embedding to move the scores. */
async function rankSettled(window, analyzed, previous) {
  let ranked = await rank(window, analyzed);
  const waitStart = Date.now();
  while (previous && signature(ranked) === previous && Date.now() - waitStart < 60_000) {
    await new Promise((r) => setTimeout(r, 5000));
    ranked = await rank(window, analyzed);
  }
  return { ranked, settledMs: Date.now() - waitStart };
}

function summarizeCondition(key, description, analyzedAfter, corpus, ranked, settledMs) {
  const rows = corpus.map((file) => ({
    name: file.name,
    expected: file.expected,
    ...(ranked.byPath.get(file.path) || { folder: null, score: null, needsReview: null })
  }));
  const held = rows.filter((r) => r.needsReview);
  const closestCounts = {};
  for (const r of held) {
    if (r.closest) closestCounts[r.closest] = (closestCounts[r.closest] || 0) + 1;
  }
  const [offerFolder, offerCount] =
    Object.entries(closestCounts).sort((a, b) => b[1] - a[1])[0] || [];
  const condition = {
    key,
    description,
    analyzedAfter,
    rankOk: ranked.ok,
    rankError: ranked.error,
    settledMs,
    rows,
    correct: rows.filter((r) => !r.needsReview && r.folder === r.expected).length,
    held: held.length,
    barOffer:
      offerFolder && offerCount >= 2 && offerFolder !== 'Uncategorized'
        ? `Send ${offerCount} to ${offerFolder}`
        : null
  };
  console.log(
    `[routing-review] ${key}: correct ${condition.correct}/${rows.length}, held ${held.length}`
  );
  return condition;
}

test.describe('Local routing review (real models)', () => {
  test.skip(!ENABLED, 'Set STRATOSORT_E2E_ROUTING_REVIEW=1 to run the local routing review.');

  let app;
  let window;
  let workDir;

  test.afterAll(async () => {
    if (app) await closeApp(app);
    if (workDir) await cleanupTempDir(workDir);
  });

  test('search console exports with the local model', async () => {
    test.setTimeout(45 * 60_000);
    const report = { startedAt: new Date().toISOString(), files: [], conditions: [] };

    ({ app, window } = await launchApp({ localModels: true }));
    await waitForAppReady(window);
    const modelReady = await waitForLoadedTextModel(window);
    test.skip(
      !modelReady,
      'No text model: set STRATOSORT_E2E_MODELS_DIR to a folder of .gguf models.'
    );
    report.textModel = await window.evaluate(
      async () => (await window.electronAPI.settings.get())?.textModel || null
    );

    workDir = await createTempDir('stratosort-routing-review-');
    const inbox = path.join(workDir, 'inbox');
    await fs.mkdir(inbox, { recursive: true });
    const corpus = await buildCorpus(inbox);

    // Folders first, as a user sets them up before analyzing.
    const folderIds = {};
    for (const folder of [{ name: GSC_FOLDER, description: '' }, ...OTHER_FOLDERS]) {
      const folderPath = path.join(workDir, 'library', folder.name);
      const added = await window.evaluate(async (f) => window.electronAPI.smartFolders.add(f), {
        name: folder.name,
        path: folderPath,
        description: folder.description
      });
      expect(added?.success, `add ${folder.name}: ${JSON.stringify(added)}`).toBe(true);
      folderIds[folder.name] = added.folder.id;
    }

    // Analyze once with no description, then change only the description:
    // what editing a folder does for files already analyzed.
    const analyzed = await analyzeAll(window, corpus, report.files);
    expect(analyzed.length, 'at least one file analyzed').toBeGreaterThan(0);

    let previous = null;
    for (const condition of GSC_DESCRIPTIONS) {
      const edited = await window.evaluate(
        async ({ id, description }) => window.electronAPI.smartFolders.edit(id, { description }),
        { id: folderIds[GSC_FOLDER], description: condition.description }
      );
      expect(edited?.success, `edit description: ${JSON.stringify(edited)}`).toBe(true);
      const { ranked, settledMs } = await rankSettled(window, analyzed, previous);
      previous = signature(ranked);
      report.conditions.push(
        summarizeCondition(condition.key, condition.description, false, corpus, ranked, settledMs)
      );
    }

    // The full description is in place: a second copy of the files (other
    // numbers, so the analysis cache misses) is analyzed with it, as files
    // added after a folder is described would be.
    const inbox2 = path.join(workDir, 'inbox-2');
    await fs.mkdir(inbox2, { recursive: true });
    const corpus2 = await buildCorpus(inbox2, 1);
    report.filesAfter = [];
    const analyzed2 = await analyzeAll(window, corpus2, report.filesAfter);
    const after = await rankSettled(window, analyzed2, null);
    const full = GSC_DESCRIPTIONS[GSC_DESCRIPTIONS.length - 1];
    report.conditions.push(
      summarizeCondition('full, analyzed after', full.description, true, corpus2, after.ranked, 0)
    );

    // Chat over the exports, as "Ask about your files" would.
    const indexed = await waitForFileInSearch(window, {
      query: 'search console clicks impressions',
      filePath: corpus[0].path,
      budgetMs: 120_000
    });
    const query = 'Which search queries got the most clicks in the Search Console exports?';
    report.chat = indexed.ok
      ? { query, ...(await askChat(window, query)) }
      : { query, ok: false, reason: 'exports did not reach the search index in 120 s' };

    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(REPORT_DIR, 'report.md'), renderMarkdown(report));
    console.log(`[routing-review] report: ${path.join(REPORT_DIR, 'report.md')}`);
  });
});
