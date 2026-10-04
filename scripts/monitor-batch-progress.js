#!/usr/bin/env node
/**
 * Poll StratoSort userData for batch analysis / embedding progress (no Electron).
 *
 * Usage:
 *   node scripts/monitor-batch-progress.js
 *   node scripts/monitor-batch-progress.js --minutes 2 --expected 150
 *   node scripts/monitor-batch-progress.js --once
 *   node scripts/monitor-batch-progress.js --until-idle
 *
 * Env:
 *   STRATOSORT_USERDATA - explicit userData directory
 *
 * Queue depth: uses embedding-queue.db when better-sqlite3 matches your Node
 * (use `npm run monitor:batch:electron-node` if system Node ABI mismatches),
 * else falls back to pending_embeddings*.json when present.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_NAME = 'analysis-history.json';
const SQLITE_DB = 'embedding-queue.db';
const SQLITE_TABLE = 'embedding_queue_kv';

const QUEUE_KEY_SUFFIX = ':queue';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { minutes: 2, once: false, untilIdle: false, expected: null, userData: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--until-idle') out.untilIdle = true;
    else if (a === '--minutes' && argv[i + 1]) {
      out.minutes = Math.max(0.25, Number(argv[++i]) || 2);
    } else if (a === '--expected' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n)) out.expected = n;
    } else if (a === '--user-data' && argv[i + 1]) {
      out.userData = argv[++i];
    }
  }
  if (process.env.STRATOSORT_USERDATA) {
    out.userData = process.env.STRATOSORT_USERDATA;
  }
  return out;
}

function candidateUserDataRoots() {
  const roots = [];
  if (process.env.STRATOSORT_USERDATA) {
    roots.push(path.resolve(process.env.STRATOSORT_USERDATA));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'StratoSort Core'));
    roots.push(path.join(process.env.APPDATA, 'stratosort-core'));
  }
  if (process.env.HOME) {
    roots.push(
      path.join(process.env.HOME, 'Library', 'Application Support', 'StratoSort Core'),
      path.join(process.env.HOME, '.config', 'StratoSort Core'),
      path.join(process.env.HOME, '.config', 'stratosort-core')
    );
  }
  return [...new Set(roots)];
}

function resolveUserData(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) {
      throw new Error(`STRATOSORT_USERDATA / --user-data not found: ${p}`);
    }
    return p;
  }
  for (const root of candidateUserDataRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    const hist = path.join(root, HISTORY_NAME);
    if (fs.existsSync(hist)) return root;
  }
  for (const root of candidateUserDataRoots()) {
    if (root && fs.existsSync(root)) return root;
  }
  throw new Error(
    'Could not find userData (no analysis-history.json). Set STRATOSORT_USERDATA or --user-data.'
  );
}

function summarizeHistory(history) {
  const entries =
    history?.entries && typeof history.entries === 'object' ? Object.values(history.entries) : [];

  let eligible = 0;
  let done = 0;
  let pending = 0;
  let error = 0;
  let skipped = 0;
  let unknown = 0;

  for (const entry of entries) {
    const embedding = entry?.embedding;
    const policy = embedding?.policy ?? null;
    const status = embedding?.status ?? 'unknown';
    const isSkipped = status === 'skipped' || policy === 'skip' || policy === 'web_only';
    if (isSkipped) {
      skipped++;
      continue;
    }
    eligible++;
    if (status === 'done') done++;
    else if (status === 'pending') pending++;
    else if (status === 'error') error++;
    else unknown++;
  }

  return {
    totalEntries: entries.length,
    eligible,
    embeddingDone: done,
    embeddingPending: pending,
    embeddingError: error,
    embeddingUnknown: unknown,
    skipped
  };
}

function decodeQueueBlob(buffer) {
  const text = buffer.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    try {
      const { uncompressSync } = require('../src/shared/lz4Codec');
      const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return JSON.parse(uncompressSync(raw).toString('utf8'));
    } catch {
      return null;
    }
  }
}

function jsonQueueLength(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { key: path.basename(filePath), length: data.length };
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      return { key: path.basename(filePath), length: keys.length };
    }
    return { key: path.basename(filePath), length: 0 };
  } catch {
    return { key: path.basename(filePath), length: null, note: 'unreadable' };
  }
}

function readJsonQueueFallback(userData) {
  const names = ['pending_embeddings.json', 'pending_embeddings_organize.json'];
  const queues = [];
  for (const n of names) {
    const full = path.join(userData, n);
    const row = jsonQueueLength(full);
    if (row && row.length !== null) {
      queues.push(row);
    }
  }
  return queues;
}

function readSqliteQueueSnapshot(userData) {
  const jsonQueues = readJsonQueueFallback(userData);
  const dbPath = path.join(userData, SQLITE_DB);
  if (!fs.existsSync(dbPath)) {
    return jsonQueues.length
      ? { available: true, queues: jsonQueues, source: 'json' }
      : { available: false, queues: [], source: 'none' };
  }
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return jsonQueues.length
      ? { available: true, queues: jsonQueues, source: 'json', note: 'better-sqlite3 not loadable' }
      : { available: false, queues: [], note: 'better-sqlite3 not loadable', source: 'none' };
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    return jsonQueues.length
      ? { available: true, queues: jsonQueues, source: 'json', note: e.message }
      : { available: false, queues: [], note: e.message, source: 'none' };
  }
  try {
    const rows = db
      .prepare(
        `SELECT key, value FROM ${SQLITE_TABLE} WHERE key LIKE '%:queue' OR key LIKE '%:failedItems' OR key LIKE '%:deadLetter'`
      )
      .all();
    const queues = [];
    for (const row of rows) {
      const key = String(row.key || '');
      const decoded = decodeQueueBlob(row.value);
      let len = 0;
      if (Array.isArray(decoded)) len = decoded.length;
      else if (decoded && typeof decoded === 'object') len = Object.keys(decoded).length;
      queues.push({ key, length: len });
    }
    return { available: true, queues, source: 'sqlite' };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

function readSettingsSnippet(userData) {
  const p = path.join(userData, 'settings.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const s = JSON.parse(raw);
    return {
      embeddingTiming: s.embeddingTiming,
      embeddingScope: s.embeddingScope,
      defaultEmbeddingPolicy: s.defaultEmbeddingPolicy,
      llamaGpuLayers: s.llamaGpuLayers,
      textModel: s.textModel,
      embeddingModel: s.embeddingModel
    };
  } catch {
    return null;
  }
}

function formatSnapshot(userData, historyStats, sqliteSnap, settings, mtimeMs) {
  const lines = [];
  lines.push(`[${new Date().toISOString()}] userData: ${userData}`);
  if (mtimeMs != null) {
    lines.push(`  analysis-history.json mtime: ${new Date(mtimeMs).toISOString()}`);
  }
  lines.push(
    `  entries: ${historyStats.totalEntries} total | eligible: ${historyStats.eligible} | skipped policy: ${historyStats.skipped}`
  );
  lines.push(
    `  embeddings — done: ${historyStats.embeddingDone} | pending: ${historyStats.embeddingPending} | error: ${historyStats.embeddingError} | unknown: ${historyStats.embeddingUnknown}`
  );
  if (sqliteSnap.available && sqliteSnap.queues.length) {
    lines.push(`  queues (${sqliteSnap.source || 'unknown'}):`);
    for (const q of sqliteSnap.queues) {
      lines.push(`    ${q.key}: ${q.length} items`);
    }
  } else if (sqliteSnap.note) {
    lines.push(`  queues: (${sqliteSnap.note})`);
  } else if (!sqliteSnap.available) {
    lines.push(`  queues: no ${SQLITE_DB} or JSON queue files yet`);
  }
  if (settings) {
    lines.push(
      `  settings: timing=${settings.embeddingTiming ?? '—'} scope=${settings.embeddingScope ?? '—'} policy=${settings.defaultEmbeddingPolicy ?? '—'} gpuLayers=${settings.llamaGpuLayers ?? '—'}`
    );
  }
  lines.push(
    '  perf: keep app foreground; prefer GPU (Settings → llamaGpuLayers -1); close other heavy GPU apps; embedding runs in batches — sustained pending→done movement every interval is healthy.'
  );
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const intervalMs = Math.round(args.minutes * 60 * 1000);
  const userData = resolveUserData(args.userData);
  const historyPath = path.join(userData, HISTORY_NAME);

  let prev = null;
  let stagnantIntervals = 0;

  for (;;) {
    let history;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(historyPath).mtimeMs;
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) {
      console.error(`[monitor] Failed to read ${historyPath}: ${e.message}`);
      if (args.once) process.exit(1);
      await sleep(intervalMs);
      continue;
    }

    const historyStats = summarizeHistory(history);
    const sqliteSnap = readSqliteQueueSnapshot(userData);
    const settings = readSettingsSnippet(userData);

    const text = formatSnapshot(userData, historyStats, sqliteSnap, settings, mtimeMs);
    console.log(text);

    if (args.expected != null && historyStats.totalEntries < args.expected * 0.9) {
      console.warn(
        `[monitor] Expected ~${args.expected} files in history; seeing ${historyStats.totalEntries} total entries.`
      );
    }

    const queueBusy = sqliteSnap.queues?.some((q) => {
      const k = String(q.key || '');
      if (k.includes('failedItems') || k.includes('deadLetter')) return false;
      const workflow = k.endsWith(QUEUE_KEY_SUFFIX) || k.includes('pending_embeddings');
      return workflow && typeof q.length === 'number' && q.length > 0;
    });
    const idle =
      !queueBusy && historyStats.embeddingPending === 0 && historyStats.embeddingError === 0;

    if (prev) {
      const deltaDone = historyStats.embeddingDone - prev.embeddingDone;
      const deltaTotal = historyStats.totalEntries - prev.totalEntries;
      const perMin = intervalMs > 0 ? (deltaDone / intervalMs) * 60_000 : 0;
      console.log(
        `  since last poll (~${args.minutes}m): +${deltaDone} embedding done | +${deltaTotal} history entries | ~${perMin.toFixed(1)} embed done/min`
      );
      if (historyStats.embeddingPending > 0 && deltaDone === 0 && deltaTotal === 0) {
        stagnantIntervals++;
        console.warn(
          `  [monitor] No embedding progress this interval (${stagnantIntervals} stagnant interval(s)); check app logs, GPU, or errors above.`
        );
      } else {
        stagnantIntervals = 0;
      }
    }

    prev = {
      embeddingDone: historyStats.embeddingDone,
      totalEntries: historyStats.totalEntries
    };

    if (args.once) break;
    if (args.untilIdle && idle && historyStats.eligible > 0) {
      console.log('[monitor] Queues empty and no pending embeddings — exiting (--until-idle).');
      break;
    }

    await sleep(intervalMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
