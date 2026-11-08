/**
 * Seed the renderer's persisted Redux state for E2E specs.
 *
 * Organize opens only once Discover has at least one analyzed file
 * (uiSlice.getPhaseNavigation), and analyzing for real needs a model. Specs
 * that test Organize itself instead seed one analyzed file the same way a
 * previous session leaves it: in the persisted blob the store loads on boot
 * (src/renderer/store/index.js loadState, key `stratosort_redux_state`).
 * The entries mirror what readyQueueHydration builds for a ready file
 * (selectedFiles + analysis.results + fileStates), so the app treats the file
 * exactly like one it analyzed itself.
 *
 * Files are real on disk, inside the launch's isolated userData dir, so
 * closeApp removes them with the profile.
 */

const fs = require('fs');
const path = require('path');
const { PHASES, mockAnalysisResult } = require('./testFixtures');
const { waitForAppReady } = require('./electronApp');

const { FILE_STATES } = require('../../../src/shared/constants');

const PERSISTED_STATE_KEY = 'stratosort_redux_state';

/**
 * CURRENT_STATE_VERSION from src/renderer/store/migrations.js (an ES module,
 * so it is read rather than required). A newer or unknown version makes
 * loadState discard the blob and start fresh, so the seed must track it.
 */
function readPersistedStateVersion() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../src/renderer/store/migrations.js'),
    'utf8'
  );
  const match = source.match(/export const CURRENT_STATE_VERSION = (\d+);/);
  if (!match) throw new Error('seedState: CURRENT_STATE_VERSION not found in migrations.js');
  return Number(match[1]);
}

/**
 * Write small text files into the app's isolated profile.
 *
 * @param {import('@playwright/test').ElectronApplication & { __e2eUserData?: string }} app
 * @param {string[]} names file names, e.g. ['quarterly-report.txt']
 * @returns {string[]} absolute paths of the created files
 */
function createSyntheticFiles(app, names) {
  const root = app && app.__e2eUserData;
  if (typeof root !== 'string' || !root) {
    throw new Error('createSyntheticFiles: app has no isolated userData dir (use launchApp)');
  }
  const dir = path.join(root, 'e2e-seed-files');
  fs.mkdirSync(dir, { recursive: true });
  return names.map((name) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, `Synthetic E2E file ${name}\nBudget figures for the quarter.\n`);
    return filePath;
  });
}

/**
 * Build the persisted-state blob for a set of analyzed files.
 *
 * @param {Array<{ path: string, analysis?: object }>} files
 * @param {{ phase?: string }} [options]
 */
function buildAnalyzedState(files, { phase = PHASES.WELCOME } = {}) {
  const now = new Date();
  const analyzedAt = now.toISOString();
  const selectedFiles = [];
  const results = [];
  const fileStates = {};

  for (const file of files) {
    const stat = fs.statSync(file.path);
    const name = path.basename(file.path);
    const fileInfo = {
      path: file.path,
      name,
      size: stat.size,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      extension: path.extname(name).toLowerCase()
    };
    const analysis = mockAnalysisResult({ suggestedName: name, ...(file.analysis || {}) });
    selectedFiles.push(fileInfo);
    results.push({ ...fileInfo, analysis, status: FILE_STATES.CATEGORIZED, analyzedAt });
    fileStates[file.path] = {
      state: 'ready',
      analysis,
      analyzedAt,
      name,
      size: fileInfo.size,
      created: fileInfo.created,
      modified: fileInfo.modified
    };
  }

  return {
    _version: readPersistedStateVersion(),
    ui: { currentPhase: phase, previousPhase: null, sidebarOpen: true, viewMode: 'phased' },
    files: {
      selectedFiles,
      smartFolders: [],
      organizedFiles: [],
      organizedPathIndex: [],
      fileStates
    },
    analysis: {
      results,
      isAnalyzing: false,
      analysisProgress: { current: 0, total: 0, lastActivity: 0 },
      currentAnalysisFile: ''
    },
    // loadState expires blobs older than the restore TTL; stamp it now.
    timestamp: now.getTime()
  };
}

/**
 * Seed analyzed files into the persisted renderer state and reload so the
 * store boots with them. Waits for the app to be ready again before returning.
 *
 * @param {import('@playwright/test').Page} window
 * @param {Array<string | { path: string, analysis?: object }>} files existing file paths
 * @param {{ phase?: string }} [options] phase the app reopens on (default Welcome)
 */
async function seedAnalyzedFiles(window, files, options = {}) {
  const entries = files.map((file) => (typeof file === 'string' ? { path: file } : file));
  if (entries.length === 0) throw new Error('seedAnalyzedFiles: no files given');
  for (const entry of entries) {
    if (!entry.path || !fs.existsSync(entry.path)) {
      throw new Error(`seedAnalyzedFiles: file does not exist: ${entry.path}`);
    }
  }
  const blob = JSON.stringify(buildAnalyzedState(entries, options));

  await window.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
      // The persistence middleware flushes a pending debounced save on
      // beforeunload. Its listener was added first, so this one runs after it
      // and the seeded blob is what the reloaded page reads.
      window.addEventListener('beforeunload', () => localStorage.setItem(key, value));
    },
    { key: PERSISTED_STATE_KEY, value: blob }
  );
  await window.reload();
  await waitForAppReady(window);
}

module.exports = {
  PERSISTED_STATE_KEY,
  createSyntheticFiles,
  buildAnalyzedState,
  seedAnalyzedFiles
};
