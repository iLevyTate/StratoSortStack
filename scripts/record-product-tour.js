#!/usr/bin/env node
/**
 * Drive a first-run Electron session through the real product loop and save
 * a how-to-use video. Local PNG dumps go under walkthrough-assets/tour/ (gitignored);
 * published stills are docs/assets/e2e-screenshots/.
 *
 *   npm run tour:record
 *
 * Isolated profile (install-like). Host GGUF models are junctioned in so
 * analysis can run. Demo files are copied into a temp inbox so Organize can
 * move them without touching the repo.
 *
 * Default is headless (Playwright still records the page + DOM pointer). Set
 * STRATOSORT_TOUR_HEADED=1 to watch the window. `npm run tour:compose` cuts
 * how-to-use.mp4 and the YouTube Short from the live video.
 *
 * --topic=library records search + graph lessons into tour-raw/library.
 * --topic=studio records settings, models, and naming into tour-raw/studio.
 * The default topic keeps the highlight capture in tour-raw/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard,
  dismissGraphTour,
  evaluateInMain
} = require('../test/e2e/helpers/electronApp');
const { NavigationPage } = require('../test/e2e/helpers/pageObjects');
const { PHASES } = require('../test/e2e/helpers/testFixtures');
const { waitForLoadedTextModel } = require('../test/e2e/helpers/liveLlm');

const TOUR_HEADED = process.env.STRATOSORT_TOUR_HEADED === '1';
const ANALYSIS_WAIT_MS = 50 * 60 * 1000;
const EMBEDDING_WAIT_MS = 5 * 60 * 1000;
const KOS_WAIT_MS = 3 * 60 * 1000;

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'walkthrough-assets');
const STILLS_DIR = path.join(OUT_DIR, 'tour');

function parseTopic() {
  const arg = process.argv.find((entry) => entry.startsWith('--topic='));
  const topic = arg ? arg.slice('--topic='.length) : 'highlight';
  if (topic !== 'highlight' && topic !== 'library' && topic !== 'studio') {
    throw new Error(`Unknown tour topic "${topic}". Use highlight, library, or studio.`);
  }
  return topic;
}

const TOPIC = parseTopic();
const VIDEO_DIR =
  TOPIC === 'highlight' ? path.join(OUT_DIR, 'tour-raw') : path.join(OUT_DIR, 'tour-raw', TOPIC);
const DEMO_DIR = path.join(OUT_DIR, 'demo-files');
const HOST_MODELS = path.join(process.env.APPDATA || '', 'StratoSort Stack', 'models');

/** @type {{ id: string, t: number, x: number, y: number, viewportWidth: number, viewportHeight: number }[]} */
const tourActions = [];
let launchAt = 0;

// Descriptions double as matcher keywords: comma-separated items are what the
// category → folder step compares against, so name the labels the model
// actually emits for these demo files.
const DEMO_FOLDERS = [
  {
    name: 'Finance',
    description: 'Budgets, forecasts, portfolio, invoices, financial'
  },
  {
    name: 'Research',
    description: 'Research papers, science, biotech, clinical trials, machine learning, biology'
  },
  {
    name: 'Nature',
    description: 'Environment, climate, wildlife, ecology, oceans, coral, reefs, arctic'
  }
];

// Record at the how-to output aspect so nothing is cropped or padded later.
const CAPTURE = { width: 1440, height: 810 };

// Knowledge OS beats phrased the way a person would actually ask.
const SEARCH_QUERY = 'how warming affects wildlife';
const CHAT_QUESTION = 'Summarize the arctic sea ice report in two sentences.';
const CHAT_WAIT_MS = 4 * 60 * 1000;

const DEMO_FILES = [
  { rel: path.join('finance', 'annual-budget-forecast-2026.txt'), folder: 'Finance' },
  { rel: path.join('finance', 'q2-2026-portfolio-performance-report.txt'), folder: 'Finance' },
  { rel: path.join('research', 'deep-learning-protein-folding.txt'), folder: 'Research' },
  { rel: path.join('research', 'crispr-gene-therapy-clinical-trials.txt'), folder: 'Research' },
  { rel: path.join('nature', 'arctic-sea-ice-monitoring-report.txt'), folder: 'Nature' },
  { rel: path.join('nature', 'coral-reef-health-assessment.txt'), folder: 'Nature' }
];

/** Newest mtime under the given directories (recursive). */
function newestMtime(dirs) {
  let newest = 0;
  const visit = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  for (const dir of dirs) {
    if (fs.existsSync(dir)) visit(dir);
  }
  return newest;
}

function isStale(bundle, sourceDirs) {
  if (!fs.existsSync(bundle)) return true;
  return fs.statSync(bundle).mtimeMs < newestMtime(sourceDirs);
}

/** Record what is in src/, not whatever dist/ happened to hold last time. */
function ensureBuild() {
  const src = (/** @type {string} */ name) => path.join(ROOT, 'src', name);
  const distMain = path.join(ROOT, 'dist', 'main.js');
  const distRenderer = path.join(ROOT, 'dist', 'renderer.js');
  if (isStale(distMain, [src('main'), src('preload'), src('shared')])) {
    console.log('[tour] Building main+preload (dist older than src)…');
    execSync('npm run build:main:dev', { cwd: ROOT, stdio: 'inherit' });
  }
  if (isStale(distRenderer, [src('renderer'), src('shared')])) {
    console.log('[tour] Building renderer (dist older than src)…');
    execSync('npm run build:dev', { cwd: ROOT, stdio: 'inherit' });
  }
}

function prepareWorkspace() {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-tour-inbox-'));
  const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-tour-library-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-tour-userdata-'));

  const files = DEMO_FILES.map((entry) => {
    const src = path.join(DEMO_DIR, entry.rel);
    if (!fs.existsSync(src)) {
      throw new Error(`Demo file missing: ${src}`);
    }
    const dest = path.join(inboxDir, path.basename(entry.rel));
    fs.copyFileSync(src, dest);
    return {
      path: dest,
      name: path.basename(entry.rel),
      folder: entry.folder,
      description: entry.description
    };
  });

  const folders = DEMO_FOLDERS.map((entry) => {
    const folderPath = path.join(libraryDir, entry.name);
    fs.mkdirSync(folderPath, { recursive: true });
    return {
      name: entry.name,
      path: folderPath,
      description: entry.description
    };
  });

  const modelsLinked = linkHostModels(userDataDir);
  return { inboxDir, libraryDir, userDataDir, files, folders, modelsLinked };
}

function linkHostModels(userDataDir) {
  if (!HOST_MODELS || !fs.existsSync(HOST_MODELS)) {
    console.warn('[tour] No host models at', HOST_MODELS);
    return false;
  }
  const dest = path.join(userDataDir, 'models');
  try {
    fs.symlinkSync(HOST_MODELS, dest, 'junction');
    console.log('[tour] Junctioned host models into isolated profile');
    return true;
  } catch (err) {
    console.warn('[tour] Could not junction models:', err.message);
    return false;
  }
}

function unlinkHostModels(userDataDir) {
  const dest = path.join(userDataDir, 'models');
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(dest);
      return;
    }
  } catch {
    return;
  }
  // Windows directory junctions often report as directories, not symlinks.
  // rmdir removes the junction without walking into the real models folder.
  try {
    fs.rmdirSync(dest);
  } catch {
    // Leave it; recursive userData cleanup must not follow a live junction.
  }
}

function cleanupWorkspace(workspace) {
  if (!workspace) return;
  unlinkHostModels(workspace.userDataDir);
  for (const dir of [workspace.inboxDir, workspace.libraryDir, workspace.userDataDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    } catch {
      // Temp dirs may still be locked briefly after Electron exits.
    }
  }
}

async function hold(window, ms) {
  await window.waitForTimeout(ms);
}

/** Action-clock second at which the sync flash was shown; -1 until clapper() runs. */
let clapAt = -1;

function persistActions(videoOffset = 0) {
  try {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(VIDEO_DIR, 'actions.json'),
      // videoOffset: seconds compose subtracts from every t to reach video PTS.
      // Measured from the clapper flash once the capture is finalized.
      JSON.stringify({ videoOffset, actions: tourActions }, null, 2)
    );
  } catch {
    // Capture can still finish; compose needs the file at the end.
  }
}

function nowSec() {
  return (Date.now() - launchAt) / 1000;
}

/**
 * Clapperboard. Neither the Electron spawn time nor the page's timeOrigin is
 * where Playwright's video actually starts, so flash a white frame at a known
 * clock time and let finalize find it in the footage.
 */
async function clapper(window) {
  await window.evaluate(() => {
    const flash = document.createElement('div');
    flash.id = 'stratosort-tour-clapper';
    flash.style.cssText =
      'position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(flash);
  });
  clapAt = nowSec();
  await hold(window, 320);
  await window.evaluate(() => document.getElementById('stratosort-tour-clapper')?.remove());
  await hold(window, 400);
}

/**
 * PTS of the clapper flash: the first dark→white edge. Requiring the edge (not
 * just brightness) ignores a window that starts white (pre-paint blank, DevTools).
 */
function findClapperFrame(video, maxSeconds = 120) {
  // lavfi's movie= source chokes on drive-letter colons; a ROOT-relative path avoids escaping.
  const rel = path.relative(ROOT, video).replace(/\\/g, '/');
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `movie=${rel},trim=duration=${maxSeconds},signalstats`,
      '-show_entries',
      'frame=pts_time:frame_tags=lavfi.signalstats.YAVG',
      '-of',
      'csv=p=0'
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (probe.status !== 0) return null;
  let previousDark = false;
  for (const line of probe.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [pts, yavg] = line.split(',');
    const luma = Number(yavg);
    if (previousDark && luma >= 200) return Number(pts);
    previousDark = luma < 120;
  }
  return null;
}

async function installTourPointer(window) {
  await window.evaluate(() => {
    const STYLE_ID = 'stratosort-tour-pointer-style';
    const NODE_ID = 'stratosort-tour-pointer';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        html.stratosort-tour-pointer, html.stratosort-tour-pointer * { cursor: none !important; }
        #stratosort-tour-pointer {
          position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none;
          width: 28px; height: 28px; margin: 0; will-change: transform;
          filter: drop-shadow(1px 2px 2px rgba(0,0,0,.45));
        }
        #stratosort-tour-pointer.is-down { transform: scale(0.88); }
      `;
      document.head.appendChild(style);
    }
    document.documentElement.classList.add('stratosort-tour-pointer');
    let node = document.getElementById(NODE_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = NODE_ID;
      node.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M3.5 2.2v20.2l5.6-5.4 4.2 9.3 3.4-1.2-4.3-8.7h8.8L3.5 2.2z" fill="#fff" stroke="#14161c" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      document.body.appendChild(node);
      window.addEventListener(
        'mousemove',
        (event) => {
          node.style.left = `${event.clientX}px`;
          node.style.top = `${event.clientY}px`;
        },
        true
      );
      window.addEventListener('mousedown', () => node.classList.add('is-down'), true);
      window.addEventListener('mouseup', () => node.classList.remove('is-down'), true);
    }
  });
}

/**
 * Record where the pointer is at a story beat. `ok: false` tells compose the
 * beat never paid off on screen (no reply, no results) so it is left out
 * rather than cut in as a spinner.
 */
async function markAction(window, id, { ok = true } = {}) {
  const pos = await window.evaluate(() => {
    const node = document.getElementById('stratosort-tour-pointer');
    const viewportWidth = window.innerWidth || 1440;
    const viewportHeight = window.innerHeight || 900;
    if (!node || !node.style.left) {
      return { x: viewportWidth / 2, y: viewportHeight / 2, viewportWidth, viewportHeight };
    }
    return {
      x: parseFloat(node.style.left) || viewportWidth / 2,
      y: parseFloat(node.style.top) || viewportHeight / 2,
      viewportWidth,
      viewportHeight
    };
  });
  const entry = { id, t: nowSec(), ok, ...pos };
  tourActions.push(entry);
  persistActions();
  console.log(
    `[tour] action ${id} t=${entry.t.toFixed(2)} @${Math.round(entry.x)},${Math.round(entry.y)}${ok ? '' : ' (no payoff)'}`
  );
}

async function movePointer(window, locator, steps = 32) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return false;
  const x = box.x + Math.min(Math.max(box.width * 0.55, 10), Math.max(box.width - 8, 10));
  const y = box.y + box.height * 0.52;
  await window.mouse.move(x, y, { steps });
  await hold(window, 180);
  return true;
}

async function moveTo(window, locator, id) {
  const moved = await movePointer(window, locator);
  if (id) await markAction(window, id);
  if (!moved) return false;
  await hold(window, 200);
  return true;
}

async function moveAndClick(window, locator, id) {
  await movePointer(window, locator);
  if (id) await markAction(window, id);
  // Animate the pointer, then let Playwright click so overlays/modals actually submit.
  await locator.click({ timeout: 8000 });
  await hold(window, 280);
}

async function shot(window, name) {
  const file = path.join(STILLS_DIR, `${name}.png`);
  await window.screenshot({ path: file, animations: 'disabled' });
  console.log(`[tour] still ${name}`);
  return file;
}

async function clickTab(window, label, id) {
  await dismissBlockingOverlay(window);
  const btn = window.getByRole('button', { name: label, exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await movePointer(window, btn).catch(() => {});
  if (id) await markAction(window, id);
  await btn.click({ timeout: 8000, force: true }).catch(() => {});
  await hold(window, 280);
  return true;
}

async function dismissBlockingOverlay(window) {
  await dismissGraphOverlays(window);
  const blocker = window.locator('div.fixed.inset-0.z-50');
  for (let i = 0; i < 4; i++) {
    if (
      !(await blocker
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await window.keyboard.press('Escape').catch(() => {});
    await hold(window, 280);
  }
}

async function captureModelWizard(window) {
  const wizard = window.locator('[role="dialog"]').filter({ hasText: 'Set up on-device AI' });
  const appeared = await wizard
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    console.log('[tour] No model wizard (models already present)');
    return false;
  }
  await hold(window, 2800);
  await shot(window, '00-model-setup');
  await dismissModelSetupWizard(window, { timeout: 3000 });
  return true;
}

async function typeVisible(locator, text, delay = 48) {
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(text, { delay });
}

async function addSmartFolder(window, folder, markId) {
  const dialog = window.locator('[role="dialog"]').filter({ hasText: 'Add Smart Folder' });
  const addBtn = window.getByRole('button', { name: 'Add folder' }).last();
  await moveAndClick(window, addBtn);
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  // Modal resetForm runs on open; wait so typing is not wiped.
  await hold(window, 400);

  const nameField = dialog.getByLabel('Folder name');
  await movePointer(window, nameField, 22);
  await typeVisible(nameField, folder.name, 52);
  await hold(window, 350);
  // Name-change kicks off an LLM description that can block submit for 15–30s
  // and overwrite what we type. Cancel it; the typed description is the story.
  const generating = dialog.getByText(/Generating description|Loading model/i);
  if (
    await generating
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await dialog
      .getByRole('button', { name: /^Cancel$/i })
      .first()
      .click()
      .catch(() => {});
    await generating
      .first()
      .waitFor({ state: 'hidden', timeout: 4000 })
      .catch(() => {});
  }

  const pathField = dialog.getByLabel('Target path');
  await pathField.click();
  await pathField.fill(folder.path);

  const desc = dialog.locator('textarea');
  await movePointer(window, desc, 16);
  await desc.click();
  await typeVisible(desc, folder.description, 28);
  await hold(window, 350);

  const submit = dialog.locator('button[type="submit"]');
  await movePointer(window, submit, 24);
  if (markId) await markAction(window, markId);
  await submit.click({ timeout: 8000 });
  // First add can cold-load the embedding model (~30s) while the modal shows
  // "Adding…". Wait it out rather than double-submitting.
  const closed = await dialog
    .waitFor({ state: 'hidden', timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    console.warn(`[tour] ${folder.name} dialog still open; submitting the form`);
    await nameField.click().catch(() => {});
    await window.keyboard.press('Enter').catch(() => {});
    await dialog.waitFor({ state: 'hidden', timeout: 20000 });
  }
  await window
    .getByText(folder.name, { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .catch(() => {});
  await hold(window, 500);
  console.log(`[tour] added smart folder ${folder.name}`);
}

async function clickPhase(window, nav, phase, markId) {
  const button = nav.getPhaseButton(phase);
  await moveAndClick(window, button, markId);
}

async function dismissGraphOverlays(window) {
  await dismissGraphTour(window, { timeout: 2800 });
  const overlay = window.getByRole('dialog').filter({
    hasText: /Search for files|Don't show this again/i
  });
  if (
    !(await overlay
      .first()
      .isVisible()
      .catch(() => false))
  )
    return;
  const dontShow = overlay.getByRole('checkbox').first();
  if (await dontShow.isVisible().catch(() => false)) {
    await dontShow.check().catch(() => {});
  }
  const close = overlay.getByRole('button', { name: /^Close$/i }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {});
  } else {
    await window.keyboard.press('Escape').catch(() => {});
  }
  await hold(window, 250);
}

async function dropDemoFiles(window, files) {
  await window.evaluate(
    (payload) => {
      window.dispatchEvent(
        new CustomEvent('app:drop-files', { detail: payload, cancelable: true })
      );
    },
    files.map((file) => ({ path: file.path, name: file.name }))
  );
}

/**
 * The first analyzed card is the "it read the file" moment: category and
 * keywords appear under the name while the rest are still processing.
 */
async function showFirstAnalyzedResult(window) {
  const category = window
    .locator('[data-testid="file-item"]')
    .getByText(/^Category:/)
    .first();
  if (!(await category.isVisible().catch(() => false))) return false;
  await moveTo(window, category, 'discover-first-result');
  await hold(window, 1200);
  return true;
}

async function waitForAnalysis(window, expectedCount) {
  const maxMs = ANALYSIS_WAIT_MS;
  console.log(`[tour] waiting for analysis of ${expectedCount} files (max ${maxMs / 1000}s)…`);
  const deadline = Date.now() + maxMs;
  let lastLog = 0;
  let firstShown = false;
  while (Date.now() < deadline) {
    const itemCount = await window.locator('[data-testid="file-item"]').count();
    if (!firstShown && itemCount >= 1) {
      firstShown = await showFirstAnalyzedResult(window);
    }
    const moveBtn = window.getByRole('button', { name: /Move \d+/i });
    if (
      itemCount >= expectedCount &&
      (await moveBtn.isEnabled({ timeout: 400 }).catch(() => false))
    ) {
      console.log(`[tour] analysis complete — already on Organize items=${itemCount}`);
      return 'organize';
    }
    const continueBtn = window.getByRole('button', { name: /Continue to Organize/i });
    if (
      itemCount >= expectedCount &&
      (await continueBtn.isEnabled({ timeout: 400 }).catch(() => false))
    ) {
      console.log(
        `[tour] analysis complete on Discover items=${itemCount} expected=${expectedCount}`
      );
      return 'discover';
    }
    const elapsed = Date.now() - (deadline - maxMs);
    if (elapsed - lastLog >= 15000) {
      lastLog = elapsed;
      console.log(
        `[tour] analysis still running items=${itemCount}/${expectedCount} (${Math.round(elapsed / 1000)}s/${maxMs / 1000}s)`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.warn('[tour] analysis wait timed out; continuing mouse tour');
  return null;
}

async function quietNotifications(window) {
  await window
    .evaluate(async () => {
      const settings = window.electronAPI?.settings;
      if (!settings?.update) return;
      await settings.update('notificationMode', 'none');
      await settings.update('notifications', false);
    })
    .catch(() => {});
}

async function waitForIndexedFiles(window, minCount) {
  const deadline = Date.now() + EMBEDDING_WAIT_MS;
  let last = -1;
  while (Date.now() < deadline) {
    const files = await window.evaluate(async () => {
      try {
        const res = await window.electronAPI?.embeddings?.getStats?.();
        const payload = res && typeof res === 'object' ? res.data || res : null;
        return typeof payload?.files === 'number' ? payload.files : 0;
      } catch {
        return 0;
      }
    });
    if (files !== last) {
      console.log(`[tour] embedding index files=${files} need=${minCount}`);
      last = files;
    }
    if (files >= minCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.warn('[tour] embedding index still short of', minCount);
  return false;
}

async function openKnowledgeOs(window) {
  const openBtn = window.getByRole('button', { name: /Open Knowledge OS/i }).first();
  if (await openBtn.isVisible().catch(() => false)) {
    await moveAndClick(window, openBtn);
  }
  const dialog = window.getByRole('dialog').filter({ hasText: 'Knowledge OS' });
  await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await window
    .getByRole('button', { name: 'Close Knowledge OS' })
    .waitFor({ state: 'visible', timeout: 8000 })
    .catch(() => {});
  await window
    .getByPlaceholder(/Describe what you're looking for/i)
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
}

async function populateSearch(window) {
  const field = window
    .getByLabel('Search query')
    .or(window.getByPlaceholder(/Describe what you're looking for/i));
  const visible = await field
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    console.warn('[tour] search field missing');
    await markAction(window, 'search', { ok: false });
    return false;
  }
  await moveTo(window, field.first());
  await typeVisible(field.first(), SEARCH_QUERY, 48);
  await hold(window, 400);
  const result = window.locator('.search-result-item').first();
  const appeared = await result
    .waitFor({ state: 'visible', timeout: KOS_WAIT_MS })
    .then(() => true)
    .catch(() => false);
  console.log(`[tour] search results ready=${appeared}`);
  if (appeared) await moveTo(window, result, 'search');
  else await markAction(window, 'search', { ok: false });
  if (TOPIC === 'library' && appeared) {
    await result.click({ timeout: 5000 }).catch((err) => {
      console.warn('[tour] search result click:', err.message);
    });
    await markAction(window, 'search-open');
    await hold(window, 1400);
  }
  if (appeared) {
    await hold(window, 900);
    const second = window.locator('.search-result-item').nth(1);
    if (await second.isVisible().catch(() => false)) {
      await moveTo(window, second);
      await hold(window, 700);
    } else {
      await hold(window, 500);
    }
  }
  return appeared;
}

async function populateChat(window) {
  const input = window.getByPlaceholder(/Ask a question about your documents/i);
  if (!(await input.isVisible().catch(() => false))) {
    console.warn('[tour] chat input missing');
    await markAction(window, 'chat-send', { ok: false });
    await markAction(window, 'chat', { ok: false });
    return false;
  }
  if (TOPIC === 'library') {
    const persona = window
      .getByText('Persona', { exact: true })
      .locator('xpath=..')
      .getByRole('combobox');
    if (await persona.isVisible().catch(() => false)) {
      await moveAndClick(window, persona, 'chat-persona');
      await hold(window, 1600);
      await window.keyboard.press('Escape').catch(() => {});
      await hold(window, 300);
    } else {
      await markAction(window, 'chat-persona', { ok: false });
    }
  }
  await moveTo(window, input);
  await typeVisible(input, CHAT_QUESTION, 42);
  const send = window.getByRole('button', { name: 'Send message' });
  if (await send.isVisible().catch(() => false)) {
    await moveAndClick(window, send, 'chat-send');
  } else {
    await markAction(window, 'chat-send');
    await input.press('Control+Enter');
  }

  const thinking = window.getByText(/Assistant thinking|Searching|Updating search context/i);
  await thinking
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {});
  const error = window.getByText(/Chat error/i);
  const deadline = Date.now() + CHAT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await error.isVisible().catch(() => false)) {
      const retry = window.getByRole('button', { name: /Retry the last chat request|Retry/i });
      if (await retry.isVisible().catch(() => false)) {
        console.log('[tour] chat timed out; retrying once');
        await retry.click();
        await hold(window, 1000);
      } else {
        break;
      }
    }
    const log = await window
      .getByRole('log', { name: 'Chat transcript' })
      .innerText()
      .catch(() => '');
    const hasError = await error.isVisible().catch(() => false);
    const stripped = String(log || '')
      .split(CHAT_QUESTION)
      .join('')
      .replace(/Found \d+ relevant sources[.\s]*/gi, '')
      .replace(/Searching your library[.\s…]*/gi, '')
      .replace(/\bYOU\b|\bASSISTANT\b/g, '')
      .replace(/Ask me anything about your documents[\s\S]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!hasError && stripped.length > 80) {
      console.log('[tour] chat reply ready');
      const transcript = window.getByRole('log', { name: 'Chat transcript' });
      await moveTo(window, transcript, 'chat');
      // Let the answer finish streaming on camera.
      await hold(window, 3500);
      return true;
    }
    await hold(window, 1000);
  }
  console.warn('[tour] chat never answered; beat will be left out of the cuts');
  await markAction(window, 'chat', { ok: false });
  return false;
}

async function populateGraph(window) {
  await dismissGraphOverlays(window);
  const nodes = window.locator('.react-flow__node');
  let appeared = await nodes
    .first()
    .waitFor({ state: 'visible', timeout: KOS_WAIT_MS })
    .then(() => true)
    .catch(() => false);
  await dismissGraphOverlays(window);
  let count = appeared ? await nodes.count() : 0;
  // A couple of cluster bubbles with no edges reads as "empty". Documents with
  // their links are the picture people expect from a graph.
  const hideClusters = window.getByRole('button', { name: /Hide clusters/i }).first();
  if (count < 4 && (await hideClusters.isVisible().catch(() => false))) {
    await moveAndClick(window, hideClusters);
    await hold(window, 900);
    appeared = await nodes
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    count = appeared ? await nodes.count() : 0;
  }
  console.log(`[tour] graph nodes=${count}`);
  if (TOPIC === 'library') {
    const dedupe = window.getByRole('button', { name: /Review & dedupe/i }).first();
    if (await dedupe.isVisible().catch(() => false)) {
      await moveAndClick(window, dedupe, 'relate-dedupe');
      await hold(window, 1600);
      await window.keyboard.press('Escape').catch(() => {});
      await hold(window, 350);
    } else {
      await markAction(window, 'relate-dedupe', { ok: false });
    }
  }
  if (!appeared) {
    await markAction(window, 'relate', { ok: false });
    return false;
  }
  const zoomIn = window
    .locator('.react-flow__controls-zoomin')
    .or(window.getByRole('button', { name: /^zoom in$/i }))
    .first();
  const zoomOut = window
    .locator('.react-flow__controls-zoomout')
    .or(window.getByRole('button', { name: /^zoom out$/i }))
    .first();
  if (await zoomIn.isVisible().catch(() => false)) {
    await moveAndClick(window, zoomIn, 'relate-zoom-in');
    await hold(window, 450);
    if (await zoomIn.isVisible().catch(() => false)) {
      await moveAndClick(window, zoomIn);
      await hold(window, 400);
    }
  } else {
    await markAction(window, 'relate-zoom-in', { ok: false });
  }
  if (await zoomOut.isVisible().catch(() => false)) {
    await moveAndClick(window, zoomOut, 'relate-zoom-out');
    await hold(window, 500);
  } else {
    await markAction(window, 'relate-zoom-out', { ok: false });
  }

  const node = nodes.first();
  await movePointer(window, node).catch(() => {});
  await markAction(window, 'relate');
  await node.click({ timeout: 5000, force: true }).catch((err) => {
    console.warn('[tour] graph node click:', err.message);
  });
  await hold(window, 1200);
  const second = nodes.nth(Math.min(count - 1, 2));
  if (count > 1 && (await second.isVisible().catch(() => false))) {
    await movePointer(window, second).catch(() => {});
    await markAction(window, 'relate-2');
    await second.click({ timeout: 5000, force: true }).catch((err) => {
      console.warn('[tour] graph second node click:', err.message);
    });
    await hold(window, 1100);
  }
  return true;
}

async function inspectFileDetails(window) {
  const detailsBtn = window.getByRole('button', { name: /View analysis details for /i }).first();
  const visible = await detailsBtn
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    console.warn('[tour] organize Details control missing');
    await markAction(window, 'organize-details', { ok: false });
    await markAction(window, 'organize-details-scroll', { ok: false });
    return false;
  }
  await moveAndClick(window, detailsBtn, 'organize-details');
  const panel = window
    .locator('[role="complementary"], [role="dialog"]')
    .filter({ hasText: 'File analysis details' })
    .first();
  const opened = await panel
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await markAction(window, 'organize-details-scroll', { ok: false });
    return false;
  }
  await hold(window, 500);
  const scroller = panel.locator('.overflow-y-auto').first();
  await scroller
    .evaluate((el) => {
      el.scrollTo({ top: Math.min(el.scrollHeight, 260), behavior: 'smooth' });
    })
    .catch(() => {});
  await markAction(window, 'organize-details-scroll');
  await hold(window, 700);
  await scroller
    .evaluate((el) => {
      el.scrollTo({ top: Math.min(el.scrollHeight, 520), behavior: 'smooth' });
    })
    .catch(() => {});
  await hold(window, 500);
  const closeBtn = window.getByRole('button', { name: 'Close panel' });
  if (await closeBtn.isVisible().catch(() => false)) {
    await moveAndClick(window, closeBtn);
  } else {
    await window.keyboard.press('Escape').catch(() => {});
  }
  await hold(window, 350);
  return true;
}

async function showAtlas(window) {
  if (!(await clickTab(window, 'Atlas'))) return false;
  const projecting = window.getByText(/Projecting your library/i);
  const empty = window.getByText(/No embedded documents yet/i);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && (await projecting.isVisible().catch(() => false))) {
    await hold(window, 500);
  }
  const canvas = window.locator('canvas').last();
  const ready =
    (await canvas
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false)) &&
    !(await empty.isVisible().catch(() => false)) &&
    !(await projecting.isVisible().catch(() => false));
  console.log(`[tour] atlas ready=${ready}`);
  if (!ready) {
    await markAction(window, 'atlas', { ok: false });
    return false;
  }
  await moveTo(window, canvas, 'atlas');
  await canvas.hover().catch(() => {});
  await window.mouse.wheel(0, -220).catch(() => {});
  await hold(window, 500);
  await window.mouse.wheel(0, 140).catch(() => {});
  await hold(window, 700);
  return true;
}

async function reviewDestinations(window, files) {
  const mapping = files.filter((file) => file.folder);
  const seen = new Set();
  let assigned = 0;
  for (const file of mapping) {
    if (seen.has(file.folder)) continue;
    const title = window.getByText(file.name, { exact: true }).first();
    await title.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await title.isVisible().catch(() => false))) continue;
    const card = title.locator('xpath=ancestor::*[.//*[@role="combobox"]][1]');
    const combo = card.getByRole('combobox').first();
    if (!(await combo.isVisible().catch(() => false))) continue;
    const current = String(await combo.innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (
      current.toLowerCase().includes(file.folder.toLowerCase()) &&
      !/uncategorized|fallback|unmapped/i.test(current)
    ) {
      seen.add(file.folder);
      continue;
    }
    await moveAndClick(window, combo, assigned === 0 ? 'organize-review' : undefined);
    const option = window.getByRole('option', { name: file.folder, exact: true });
    const opened = await option
      .waitFor({ state: 'visible', timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      await window.keyboard.press('Escape').catch(() => {});
      continue;
    }
    await moveAndClick(window, option);
    seen.add(file.folder);
    assigned += 1;
    await hold(window, 500);
    if (seen.size >= 3) break;
  }
  console.log(`[tour] destination reviews=${assigned}`);
  return assigned;
}

async function goToOrganize(window, nav, where) {
  if (where === 'organize') return;
  const continueBtn = window.getByRole('button', {
    name: /Continue to Organize|Continue without analysis/i
  });
  if (await continueBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await continueBtn.scrollIntoViewIfNeeded().catch(() => {});
    await moveAndClick(window, continueBtn).catch(() => {});
  }
  const moveBtn = window.getByRole('button', { name: /Move \d+/i });
  if (await moveBtn.isVisible({ timeout: 3000 }).catch(() => false)) return;
  await nav.goToPhase(PHASES.ORGANIZE).catch(() => {});
}

async function closeDetachedDevTools(app) {
  await evaluateInMain(app, ({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win.webContents && win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        }
        const url = win.webContents.getURL();
        if (typeof url === 'string' && url.startsWith('devtools:')) {
          win.close();
        }
      } catch {
        // Window may already be gone.
      }
    }
  });
}

async function preferAppWindow(app, fallback) {
  const pages = typeof app.windows === 'function' ? app.windows() : [];
  for (const page of pages) {
    const url = page.url();
    if (url && !url.startsWith('devtools:')) {
      return page;
    }
  }
  return fallback;
}

async function expandSettingsSection(window, name) {
  const button = window
    .locator('button[aria-label^="Expand section"], button[aria-label^="Collapse section"]')
    .filter({ hasText: name })
    .first();
  await button.scrollIntoViewIfNeeded().catch(() => {});
  const open = await button.getAttribute('aria-expanded').catch(() => 'false');
  if (open !== 'true') await moveAndClick(window, button);
  else await movePointer(window, button);
  await hold(window, 450);
}

/** Open a custom select and leave its option list on screen. Returns the combobox. */
async function openChooser(window, headingName, markId) {
  await closeChooser(window);
  const heading = window.getByRole('heading', { name: headingName, exact: true }).last();
  await heading.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
  const found = await heading.isVisible().catch(() => false);
  if (!found) {
    await markAction(window, markId, { ok: false });
    return null;
  }
  const box = heading
    .locator('xpath=ancestor::div[contains(@class,"flex-col")][1]')
    .getByRole('combobox')
    .first();
  const visible = await box.isVisible().catch(() => false);
  if (!visible) {
    await markAction(window, markId, { ok: false });
    return null;
  }
  await moveAndClick(window, box, markId);
  await hold(window, 1500);
  return box;
}

async function closeChooser(window) {
  const open = window.locator('[role="combobox"][aria-expanded="true"]');
  if ((await open.count().catch(() => 0)) > 0) {
    await open
      .first()
      .click({ force: true })
      .catch(() => {});
    await hold(window, 250);
  }
}

/**
 * Settings, local model menus, and the naming preview. No files are analyzed.
 * No API key is typed and the MCP token stays masked.
 */
async function runStudio(window, nav) {
  const gear = window.getByRole('button', { name: 'Open settings' });
  await moveAndClick(window, gear, 'settings-open');
  const panel = window.getByRole('dialog', { name: 'Settings' });
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  await hold(window, 500);

  const advanced = panel.getByRole('button', { name: 'Advanced', exact: true });
  await moveAndClick(window, advanced, 'settings-advanced');
  await hold(window, 700);

  await expandSettingsSection(window, 'AI Provider');
  const providerCard = panel.getByText(/Local stays on your machine/i).first();
  if (await providerCard.isVisible().catch(() => false)) {
    await moveTo(window, providerCard, 'settings-provider');
  } else {
    await markAction(window, 'settings-provider');
  }
  await hold(window, 900);

  const openai = panel.locator('label').filter({ hasText: 'OpenAI / Custom' }).first();
  const radio = openai.locator('input[type="radio"]');
  if (await radio.isVisible().catch(() => false)) {
    await moveAndClick(window, radio);
  }
  const consent = window
    .getByRole('dialog')
    .filter({ hasText: /Embeddings are always computed locally/i });
  const consentShown = await consent
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (consentShown) {
    await markAction(window, 'settings-consent');
    await hold(window, 2200);
    const keepLocal = consent.getByRole('button', { name: 'Keep local' });
    await moveAndClick(window, keepLocal, 'settings-consent-close');
    await hold(window, 500);
  } else {
    await markAction(window, 'settings-consent', { ok: false });
    await markAction(window, 'settings-consent-close', { ok: false });
  }

  const configure = openai.getByRole('button', { name: 'Configure...' });
  if (await configure.isVisible().catch(() => false)) {
    await moveAndClick(window, configure, 'settings-key');
    const keyDialog = window.getByRole('dialog').filter({ hasText: /API key/i });
    await keyDialog.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await hold(window, 1800);
    const cancel = keyDialog.getByRole('button', { name: 'Cancel' });
    if (await cancel.isVisible().catch(() => false)) {
      await moveAndClick(window, cancel, 'settings-key-cancel');
    } else {
      await window.keyboard.press('Escape').catch(() => {});
      await markAction(window, 'settings-key-cancel');
    }
    await hold(window, 400);
  } else {
    await markAction(window, 'settings-key', { ok: false });
    await markAction(window, 'settings-key-cancel', { ok: false });
  }

  await expandSettingsSection(window, 'MCP Server');
  const mcpToggle = panel.getByRole('checkbox', { name: 'Enable MCP server' });
  if (await mcpToggle.isVisible().catch(() => false)) {
    await moveAndClick(window, mcpToggle, 'settings-mcp');
  } else {
    await markAction(window, 'settings-mcp', { ok: false });
  }
  const running = panel.getByText(/Running on http:\/\/127\.0\.0\.1/i);
  const mcpUp = await running
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  console.log(`[tour] mcp running=${mcpUp}`);
  if (mcpUp) await moveTo(window, running, 'settings-mcp-on');
  else await markAction(window, 'settings-mcp-on', { ok: false });
  await hold(window, 800);
  const tools = panel.getByText('search_documents').first();
  if (await tools.isVisible().catch(() => false)) {
    await moveTo(window, tools, 'settings-mcp-tools');
    await hold(window, 1200);
  } else {
    await markAction(window, 'settings-mcp-tools', { ok: false });
  }
  const copyCursor = panel.getByRole('button', { name: 'Copy Cursor config' });
  if (await copyCursor.isVisible().catch(() => false)) {
    await moveAndClick(window, copyCursor, 'settings-mcp-copy');
    await hold(window, 1400);
  } else {
    await markAction(window, 'settings-mcp-copy', { ok: false });
  }

  await expandSettingsSection(window, 'AI Configuration');
  const ready = panel.getByText(/Ready \(/i).first();
  const readyShown = await ready
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (readyShown) await moveTo(window, ready, 'models-ready');
  else await markAction(window, 'models-ready');
  await hold(window, 1200);
  const available = panel.getByText(/\d+ models available|1 model available/i).first();
  if (await available.isVisible().catch(() => false)) {
    await moveTo(window, available, 'models-count');
    await hold(window, 900);
  }

  await openChooser(window, 'Text model', 'models-text');
  await closeChooser(window);
  await openChooser(window, 'Vision model', 'models-vision');
  await closeChooser(window);
  const embedBox = await openChooser(window, 'Embedding model', 'models-embed');
  if (embedBox) {
    const options = window.getByRole('option');
    const optionCount = await options.count().catch(() => 0);
    if (optionCount > 1) {
      await options
        .nth(1)
        .click({ timeout: 4000 })
        .catch(() => {});
      const rebuild = window
        .getByRole('dialog')
        .filter({ hasText: /invalidate existing embeddings/i });
      const shown = await rebuild
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (shown) {
        await markAction(window, 'models-embed-dialog');
        await hold(window, 2000);
        const cancel = rebuild.getByRole('button', { name: 'Cancel' });
        await moveAndClick(window, cancel, 'models-embed-cancel');
        await hold(window, 400);
      } else {
        await markAction(window, 'models-embed-dialog', { ok: false });
        await markAction(window, 'models-embed-cancel', { ok: false });
        await closeChooser(window);
      }
    } else {
      await markAction(window, 'models-embed-dialog', { ok: false });
      await markAction(window, 'models-embed-cancel', { ok: false });
      await closeChooser(window);
    }
  } else {
    await markAction(window, 'models-embed-dialog', { ok: false });
    await markAction(window, 'models-embed-cancel', { ok: false });
  }

  const gpu = panel.getByRole('textbox', { name: 'GPU layers' }).or(panel.getByLabel('GPU layers'));
  if (
    await gpu
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await gpu
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await moveTo(window, gpu.first(), 'models-gpu');
    await hold(window, 1000);
  } else {
    await markAction(window, 'models-gpu', { ok: false });
  }

  const download = panel.getByRole('button', { name: /^Download/ }).first();
  if (await download.isVisible().catch(() => false)) {
    await download.scrollIntoViewIfNeeded().catch(() => {});
    await moveTo(window, download, 'models-catalog');
    await hold(window, 1400);
  } else {
    await markAction(window, 'models-catalog', { ok: false });
  }

  await window.keyboard.press('Escape').catch(() => {});
  await hold(window, 400);
  await clickPhase(window, nav, PHASES.DISCOVER);
  await hold(window, 600);
  const expandGuide = window.getByRole('button', { name: 'Expand discover guide' });
  if (await expandGuide.isVisible().catch(() => false)) {
    await moveAndClick(window, expandGuide);
    await hold(window, 400);
  }
  const namingBtn = window.getByTestId('naming-strategy-trigger');
  if (await namingBtn.isVisible().catch(() => false)) {
    await moveAndClick(window, namingBtn, 'naming-open');
  } else {
    await markAction(window, 'naming-open', { ok: false });
  }
  const naming = window.getByRole('dialog', { name: 'Naming strategy' });
  const namingShown = await naming
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  if (!namingShown) {
    console.warn('[tour] naming dialog missing');
    return;
  }
  const convention = naming.getByRole('combobox').nth(0);
  await moveAndClick(window, convention);
  const project = window.getByRole('option', { name: 'project-subject-date' });
  if (await project.isVisible().catch(() => false)) {
    await moveAndClick(window, project, 'naming-convention');
  } else {
    await markAction(window, 'naming-convention', { ok: false });
    await closeChooser(window);
  }
  await hold(window, 700);
  const caseBox = naming.getByRole('combobox').nth(2);
  await moveAndClick(window, caseBox);
  const snake = window.getByRole('option', { name: 'snake_case' });
  if (await snake.isVisible().catch(() => false)) {
    await moveAndClick(window, snake, 'naming-case');
  } else {
    await markAction(window, 'naming-case', { ok: false });
    await closeChooser(window);
  }
  await hold(window, 500);
  const preview = naming.getByTestId('naming-preview-value');
  if (await preview.isVisible().catch(() => false)) {
    await moveTo(window, preview, 'naming-preview');
    await hold(window, 1800);
  } else {
    await markAction(window, 'naming-preview', { ok: false });
  }
  const done = naming.getByRole('button', { name: 'Done' });
  if (await done.isVisible().catch(() => false)) await moveAndClick(window, done);
}

async function run() {
  console.log(`[tour] topic=${TOPIC}`);
  ensureBuild();
  fs.mkdirSync(STILLS_DIR, { recursive: true });
  if (fs.existsSync(VIDEO_DIR)) {
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });

  const workspace = prepareWorkspace();
  console.log(
    `[tour] Launching Electron (${TOUR_HEADED ? 'headed' : 'headless'}, recording, ${workspace.files.length} demo files)…`
  );
  launchAt = Date.now();
  // The shared e2e launcher forces software rendering + CPU-only inference for
  // CI determinism. A product recording wants the real machine: GPU inference
  // is what makes analysis and Chat fast enough to watch.
  const env = {
    STRATOSORT_REDACT_PATHS: '1',
    STRATOSORT_FORCE_SOFTWARE_GPU: '0',
    ELECTRON_DISABLE_GPU: '0'
  };
  let launched;
  try {
    launched = await launchApp({
      headed: TOUR_HEADED,
      userDataDir: workspace.userDataDir,
      recordVideo: { dir: VIDEO_DIR, size: { ...CAPTURE } },
      env
    });
  } catch (err) {
    console.warn(`[tour] launch with recordVideo failed (${err.message}); retrying stills-only.`);
    launched = await launchApp({
      headed: TOUR_HEADED,
      userDataDir: workspace.userDataDir,
      env
    });
  }
  const { app } = launched;
  let { window } = launched;
  window = await preferAppWindow(app, window);
  window.setDefaultTimeout(60_000);

  try {
    await waitForAppReady(window);
    await closeDetachedDevTools(app);
    window = await preferAppWindow(app, window);
    window.setDefaultTimeout(60_000);
    await installTourPointer(window);
    await clapper(window);
    await evaluateInMain(
      app,
      ({ BrowserWindow }, { headed, width, height }) => {
        const wins = BrowserWindow.getAllWindows().filter((win) => {
          try {
            return !String(win.webContents.getURL() || '').startsWith('devtools:');
          } catch {
            return true;
          }
        });
        const win = wins[0];
        if (!win) return false;
        try {
          // Content size, not window size: the frame otherwise eats ~33px and
          // Playwright pads the video with a grey band.
          win.setContentSize(width, height);
        } catch {
          win.setSize(width, height);
        }
        if (headed) {
          win.center();
          win.show();
          win.focus();
        }
        return true;
      },
      { headed: TOUR_HEADED, ...CAPTURE }
    );
    await hold(window, 600);
    await installTourPointer(window);
    await captureModelWizard(window);
    await installTourPointer(window);
    await quietNotifications(window);

    const nav = new NavigationPage(window);

    if (TOPIC === 'studio') {
      await runStudio(window, nav);
      await hold(window, 800);
    } else {
      await nav.goToPhase(PHASES.WELCOME).catch(() => {});
      await hold(window, 800);
      await installTourPointer(window);
      await shot(window, '01-welcome');

      // Show the four-step story, then Setup. "Get started" jumps to Discover and
      // skips destinations, so close the explainer and click Setup in the navbar.
      const workflowBtn = window.getByRole('button', { name: 'See the full workflow' });
      if (await workflowBtn.isVisible().catch(() => false)) {
        await moveAndClick(window, workflowBtn, 'welcome-cta');
        await window.getByRole('dialog').filter({ hasText: 'How StratoSort works' }).waitFor({
          state: 'visible',
          timeout: 5000
        });
        await hold(window, 1700);
        const getStarted = window.getByRole('button', { name: 'Get started' });
        await moveTo(window, getStarted, 'how-it-works');
        await shot(window, '01b-how-it-works');
        await window.keyboard.press('Escape');
        await hold(window, 350);
      } else {
        await markAction(window, 'welcome-cta');
        await markAction(window, 'how-it-works');
      }

      await clickPhase(window, nav, PHASES.SETUP);
      await hold(window, 700);
      await installTourPointer(window);
      const folderMarks = ['setup-add', 'setup-research', 'setup-nature'];
      for (const [index, folder] of workspace.folders.entries()) {
        await addSmartFolder(window, folder, folderMarks[index]);
      }
      await hold(window, 600);
      await shot(window, '02-setup-smart-folders');

      const continueDiscover = window.getByRole('button', { name: /Continue to Discovery/i });
      if (await continueDiscover.isVisible().catch(() => false)) {
        await moveAndClick(window, continueDiscover);
      } else {
        await clickPhase(window, nav, PHASES.DISCOVER);
      }
      await hold(window, 700);
      await installTourPointer(window);

      const modelReady = await waitForLoadedTextModel(window, { timeoutMs: 180_000 });
      console.log(`[tour] text model ready=${modelReady}`);

      const dropZone = window.getByRole('button', { name: 'Select files' }).first();
      if (await dropZone.isVisible().catch(() => false)) {
        await moveTo(window, dropZone);
      }
      await dropDemoFiles(window, workspace.files);
      await window
        .getByText(/files ready|waiting for analysis/i)
        .first()
        .waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => {});
      const droppedName = window.getByText(workspace.files[0].name, { exact: true }).first();
      const listed = await droppedName
        .waitFor({ state: 'visible', timeout: 12000 })
        .then(() => true)
        .catch(() => false);
      if (listed) await moveTo(window, droppedName, 'discover-drop');
      else await markAction(window, 'discover-drop');
      await hold(window, 1200);
      await shot(window, '03-discover');
      const analyzed = await waitForAnalysis(window, workspace.files.length);
      await hold(window, 600);
      const categorized = window.getByText(/\b(Finance|Nature|Research)\b/).first();
      if (await categorized.isVisible().catch(() => false)) {
        await moveTo(window, categorized, 'discover-analyzed');
        await hold(window, 800);
      } else {
        await markAction(window, 'discover-analyzed');
      }
      await shot(window, '03b-discover-analyzed');
      await goToOrganize(window, nav, analyzed);
      await hold(window, 900);
      await installTourPointer(window);
      await shot(window, '04-organize');

      const fileCard = window
        .getByText(/annual-budget-forecast|arctic-sea-ice|Suggested name/i)
        .first();
      if (await fileCard.isVisible().catch(() => false)) {
        await moveTo(window, fileCard, 'organize-file');
      } else {
        await markAction(window, 'organize-file');
      }
      await inspectFileDetails(window);
      const reviewed = await reviewDestinations(window, workspace.files);
      await hold(window, reviewed > 0 ? 800 : 400);

      const moveBtn = window.getByRole('button', { name: /Move \d+/i });
      if (
        (await moveBtn.isVisible().catch(() => false)) &&
        (await moveBtn.isEnabled({ timeout: 2000 }).catch(() => false))
      ) {
        await moveAndClick(window, moveBtn, 'organize-move');
        const completeHeading = window.getByRole('heading', { name: /Organization Complete/i });
        const resultsBtn = window.getByRole('button', { name: /View results/i });
        await resultsBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await movePointer(window, resultsBtn, 18).catch(() => {});
        const settled = Date.now() + 180_000;
        let reachedComplete = false;
        while (Date.now() < settled) {
          if (await completeHeading.isVisible().catch(() => false)) {
            reachedComplete = true;
            break;
          }
          if (await resultsBtn.isEnabled({ timeout: 400 }).catch(() => false)) {
            await moveAndClick(window, resultsBtn, 'complete');
            reachedComplete = true;
            break;
          }
          await hold(window, 1000);
        }
        await hold(window, 900);
        await shot(window, '04b-organize-moved');
        if (await completeHeading.isVisible().catch(() => false)) {
          if (!tourActions.some((entry) => entry.id === 'complete')) {
            await markAction(window, 'complete');
          }
          await hold(window, 1400);
          await shot(window, '05-complete');
        } else if (!reachedComplete) {
          console.warn('[tour] Complete phase not reached after move.');
        }
      } else {
        console.warn('[tour] Organize move control not ready; skipping move.');
      }

      const indexed = await waitForIndexedFiles(window, Math.max(3, workspace.files.length - 2));
      console.log(`[tour] knowledge OS index ready=${indexed}`);
      await openKnowledgeOs(window);
      await hold(window, 500);
      await installTourPointer(window);
      await populateSearch(window);
      await hold(window, 700);
      await shot(window, '06-knowledge-os-search');

      const viewInGraph = window.getByRole('button', { name: /View in Graph/i }).first();
      if (await viewInGraph.isVisible().catch(() => false)) {
        await moveAndClick(window, viewInGraph);
        await hold(window, 800);
        await dismissBlockingOverlay(window);
      }

      if (await clickTab(window, 'Chat')) {
        await hold(window, 500);
        await populateChat(window);
        await hold(window, 900);
        await shot(window, '07-knowledge-os-chat');
      }

      try {
        if (await clickTab(window, 'Relate')) {
          await hold(window, 500);
          await populateGraph(window);
          await hold(window, 800);
          await shot(window, '08-knowledge-os-relate');
        }
      } catch (err) {
        console.warn('[tour] relate:', err.message);
      }

      if (TOPIC !== 'library') {
        try {
          if (await showAtlas(window)) {
            await shot(window, '09b-knowledge-os-atlas');
          }
        } catch (err) {
          console.warn('[tour] atlas:', err.message);
        }
      }

      await hold(window, 1500);
    }
  } finally {
    persistActions();
    console.log(`[tour] wrote ${tourActions.length} mouse actions`);
    await Promise.race([closeApp(app), new Promise((resolve) => setTimeout(resolve, 30000))]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const capture = finalizeCapturedVideo();
      if (capture && clapAt >= 0) {
        const flashAt = findClapperFrame(path.join(VIDEO_DIR, 'app.webm'));
        if (flashAt === null) {
          console.warn('[tour] clapper flash not found in footage; videoOffset left at 0');
        } else {
          const videoOffset = Number((clapAt - flashAt).toFixed(3));
          persistActions(videoOffset);
          console.log(
            `[tour] clapper at clock ${clapAt.toFixed(2)}s = video ${flashAt.toFixed(2)}s → videoOffset ${videoOffset}s`
          );
        }
      }
    } catch (err) {
      console.warn('[tour] video finalize failed:', err.message);
    }
    cleanupWorkspace(workspace);
  }
}

function ffprobeJson(file) {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      file
    ],
    { encoding: 'utf8' }
  );
  if (probe.status !== 0) return null;
  try {
    return JSON.parse(probe.stdout);
  } catch {
    return null;
  }
}

/**
 * Playwright records every page it sees — including a DevTools window if one
 * opens. The app footage is the one that contains the clapper flash; size and
 * duration are only tie-breakers.
 */
function pickAppWindowVideo(webms) {
  const scored = webms
    .map((file) => {
      const info = ffprobeJson(file);
      const stream = info?.streams?.[0];
      const width = Number(stream?.width || 0);
      const height = Number(stream?.height || 0);
      const duration = Number(info?.format?.duration || 0);
      const exact = width === CAPTURE.width && height === CAPTURE.height;
      const large = width >= 1280 && height >= 720;
      return { file, width, height, duration, exact, large, flashAt: null };
    })
    .filter((entry) => entry.large);
  if (scored.length > 1 && clapAt >= 0) {
    for (const entry of scored) entry.flashAt = findClapperFrame(entry.file);
    const flashed = scored.filter((entry) => entry.flashAt !== null);
    if (flashed.length > 0) return flashed[0];
  }
  const exact = scored.filter((entry) => entry.exact);
  const pool = exact.length > 0 ? exact : scored;
  pool.sort((a, b) => b.duration - a.duration);
  return pool[0] || null;
}

function finalizeCapturedVideo() {
  const webms = fs.existsSync(VIDEO_DIR)
    ? fs
        .readdirSync(VIDEO_DIR)
        .filter((name) => name.endsWith('.webm') && name !== 'app.webm')
        .map((name) => path.join(VIDEO_DIR, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  const chosen = pickAppWindowVideo(webms);
  if (!chosen) {
    console.warn('[tour] no app-window webm found. Compose cannot build live mouse cuts.');
    return null;
  }
  const dest = path.join(VIDEO_DIR, 'app.webm');
  fs.copyFileSync(chosen.file, dest);
  console.log(
    `[tour] saved live capture ${path.basename(chosen.file)} ${chosen.width}x${chosen.height} ${chosen.duration.toFixed(1)}s → app.webm`
  );
  console.log(
    '[tour] run `npm run tour:compose` to cut how-to-use.mp4 and the Short from this video.'
  );
  return chosen;
}

run().catch((err) => {
  console.error('[tour] failed:', err);
  process.exit(1);
});
