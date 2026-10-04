/**
 * Offline embedding-quality probe.
 *
 * Loads the configured GGUF embedding model directly through node-llama-cpp
 * (no Electron) and reports, for a representative set of documents and smart
 * folders, the cosine similarity between each document and every folder. It
 * compares three input schemes so we can tune `FOLDER_MATCH_CONFIDENCE` and
 * decide whether nomic task-instruction prefixes actually help on real data:
 *
 *   - raw          : no prefix (the historical behavior)
 *   - symmetric    : "search_document:" on BOTH folders and documents
 *   - asymmetric   : "search_document:" on folders, "search_query:" on documents
 *
 * Prefixes are only applied for nomic-family models (mirroring the runtime
 * helper); for all-MiniLM/mxbai/etc. all three schemes collapse to "raw".
 *
 * Usage (PowerShell):
 *   node scripts/measure-embedding-scores.js
 *   node scripts/measure-embedding-scores.js --model all-MiniLM-L6-v2-Q4_K_M.gguf
 *   $env:STRATOSORT_EMBEDDING_MODEL="nomic-embed-text-v1.5-Q8_0.gguf"; node scripts/measure-embedding-scores.js
 *
 * The folder/document fixtures below intentionally mirror the kinds of files
 * the app mis-routed (resumes, NDAs, advisor agreements, interview guides,
 * trading docs, lab requisitions, lead CSVs, scripts). Edit them to match your
 * own corpus when tuning.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_MODEL = 'nomic-embed-text-v1.5-Q8_0.gguf';

/** Resolve the userData models directory the desktop app uses per-OS. */
function resolveModelsDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'StratoSort Core', 'models');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'StratoSort Core', 'models');
  }
  return path.join(os.homedir(), '.config', 'StratoSort Core', 'models');
}

function parseArgs(argv) {
  const args = { model: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model' && argv[i + 1]) {
      args.model = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const isNomicFamily = (modelName) => /nomic-embed/i.test(String(modelName || ''));

/** Mirror of the runtime task-prefix scheme (nomic-only). */
function withPrefix(text, modelName, task) {
  if (!isNomicFamily(modelName)) return text;
  const prefix = task === 'query' ? 'search_query: ' : 'search_document: ';
  return `${prefix}${text}`;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Representative smart folders (name + description used for the folder embedding).
const FOLDERS = [
  {
    name: 'Resumes & CVs',
    description: 'Resumes, curriculum vitae, cover letters, job applications'
  },
  {
    name: 'Legal',
    description: 'Contracts, NDAs, non-disclosure agreements, advisor agreements, legal documents'
  },
  { name: 'Financial', description: 'Invoices, receipts, budgets, financial statements, payments' },
  {
    name: 'Interview Prep',
    description: 'Interview guides, study notes, reference guides, preparation material'
  },
  {
    name: 'Engineering',
    description: 'Source code, technical design docs, trading engines, software architecture'
  },
  {
    name: 'Medical',
    description: 'Lab requisitions, test requests, medical records, health documents'
  },
  {
    name: 'Identity Documents',
    description: 'Social security cards, passports, identification, official IDs'
  },
  {
    name: 'Marketing Leads',
    description: 'Sales leads, prospect lists, CRM exports, contact spreadsheets'
  }
];

// Representative documents (summary text the pipeline would embed) + expected folder.
const DOCS = [
  {
    label: 'resume.pdf',
    expected: 'Resumes & CVs',
    text: 'Ben Kennedy PhD AI. Resume and curriculum vitae detailing work experience, education, skills in machine learning and artificial intelligence, and professional accomplishments.'
  },
  {
    label: 'NDA_Final.pdf',
    expected: 'Legal',
    text: 'Mutual Non-Disclosure Agreement between two parties governing confidential information, obligations of confidentiality, term, and remedies for breach.'
  },
  {
    label: 'Advisor_Agreement.pdf',
    expected: 'Legal',
    text: 'Advisor Agreement setting out the terms under which an advisor provides services, equity compensation, vesting schedule, and intellectual property assignment.'
  },
  {
    label: 'INTERVIEW_GUIDE.md',
    expected: 'Interview Prep',
    text: 'Interview reference guide with common questions, talking points, system design topics, and preparation notes for a software engineering interview.'
  },
  {
    label: 'TradeAlgo Trading Engine.md',
    expected: 'Engineering',
    text: 'Trading Engine v11 interview reference guide describing the architecture of an algorithmic trading system, order routing, execution, and risk modules.'
  },
  {
    label: 'labcorp_test_req.pdf',
    expected: 'Medical',
    text: 'Laboratory test requisition form from a medical provider ordering blood work and diagnostic panels for a patient.'
  },
  {
    label: 'SocialSecurityCard.pdf',
    expected: 'Identity Documents',
    text: 'Scanned image of a United States Social Security card showing a name and social security number.'
  },
  {
    label: 'LeadsFromDripify.csv',
    expected: 'Marketing Leads',
    text: 'Spreadsheet export of sales leads and prospects with names, titles, companies, and LinkedIn profile URLs from an outreach campaign.'
  },
  {
    label: 'extract_codebase_optimization.py',
    expected: 'Engineering',
    text: 'Python script that walks a source tree, extracts code, and applies optimization heuristics. Imports os, ast, and pathlib; defines functions for parsing modules.'
  }
];

async function embedAll(context, texts) {
  const vectors = [];
  for (const t of texts) {
    const emb = await context.getEmbeddingFor(t);
    vectors.push(Array.from(emb.vector));
  }
  return vectors;
}

function rankDoc(docVec, folderVecs) {
  return FOLDERS.map((f, i) => ({ name: f.name, score: cosine(docVec, folderVecs[i]) })).sort(
    (a, b) => b.score - a.score
  );
}

async function runScheme(context, modelName, schemeName, folderTask, docTask) {
  const folderTexts = FOLDERS.map((f) =>
    withPrefix(`${f.name}. ${f.description}`, modelName, folderTask)
  );
  const docTexts = DOCS.map((d) => withPrefix(d.text, modelName, docTask));

  const folderVecs = await embedAll(context, folderTexts);
  const docVecs = await embedAll(context, docTexts);

  let correct = 0;
  let sumTop1 = 0;
  let sumMargin = 0;
  let sumCorrectScore = 0;
  const rows = [];

  DOCS.forEach((doc, i) => {
    const ranked = rankDoc(docVecs[i], folderVecs);
    const top1 = ranked[0];
    const top2 = ranked[1] || { score: 0 };
    const correctEntry = ranked.find((r) => r.name === doc.expected) || { score: 0 };
    const isCorrect = top1.name === doc.expected;
    if (isCorrect) correct += 1;
    sumTop1 += top1.score;
    sumMargin += top1.score - top2.score;
    sumCorrectScore += correctEntry.score;
    rows.push({
      doc: doc.label,
      expected: doc.expected,
      top1: `${top1.name} (${top1.score.toFixed(3)})`,
      correctScore: correctEntry.score.toFixed(3),
      hit: isCorrect ? 'Y' : 'n'
    });
  });

  const n = DOCS.length;
  return {
    schemeName,
    accuracy: correct / n,
    meanTop1: sumTop1 / n,
    meanMargin: sumMargin / n,
    meanCorrectScore: sumCorrectScore / n,
    rows
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelName = args.model || process.env.STRATOSORT_EMBEDDING_MODEL || DEFAULT_MODEL;
  const modelsDir = resolveModelsDir();
  const modelPath = path.join(modelsDir, modelName);

  if (!fs.existsSync(modelPath)) {
    console.error(`Model not found: ${modelPath}`);
    console.error('Pass --model <file.gguf> or set STRATOSORT_EMBEDDING_MODEL.');
    process.exit(1);
  }

  console.log(`Model: ${modelName}`);
  console.log(`Path:  ${modelPath}`);
  console.log(
    `Nomic task prefixes: ${isNomicFamily(modelName) ? 'ON' : 'off (not nomic-family)'}\n`
  );

  const { getLlama } = await import('node-llama-cpp');
  const llama = await getLlama({ gpu: false });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  const schemes = [
    await runScheme(context, modelName, 'raw', null, null),
    await runScheme(context, modelName, 'symmetric (doc/doc)', 'document', 'document'),
    await runScheme(context, modelName, 'asymmetric (doc/query)', 'document', 'query')
  ];

  for (const s of schemes) {
    console.log(`\n=== Scheme: ${s.schemeName} ===`);
    console.table(s.rows);
    console.log(
      `accuracy=${(s.accuracy * 100).toFixed(0)}%  meanTop1=${s.meanTop1.toFixed(3)}  ` +
        `meanMargin=${s.meanMargin.toFixed(3)}  meanCorrectScore=${s.meanCorrectScore.toFixed(3)}`
    );
  }

  console.log(
    '\n--- Summary (higher accuracy/margin is better; use meanCorrectScore to set FOLDER_MATCH_CONFIDENCE) ---'
  );
  console.table(
    schemes.map((s) => ({
      scheme: s.schemeName,
      accuracy: `${(s.accuracy * 100).toFixed(0)}%`,
      meanTop1: s.meanTop1.toFixed(3),
      meanMargin: s.meanMargin.toFixed(3),
      meanCorrectScore: s.meanCorrectScore.toFixed(3)
    }))
  );

  await context.dispose?.();
  await model.dispose?.();
}

main().catch((err) => {
  console.error('measure-embedding-scores failed:', err);
  process.exit(1);
});
