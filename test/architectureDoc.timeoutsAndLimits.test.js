/**
 * Doc-truth coverage for the two numeric promises docs/ARCHITECTURE.md makes
 * about the analysis pipeline:
 *
 *   1. the per-image vision timeout (audit row C8), and
 *   2. which extraction limits a user can actually change (audit row U3).
 *
 * Both were wrong at af98e67d. The VisionService paragraph named
 * `imageAnalysisTimeout` -- a dead `CONFIG_SCHEMA` entry nothing read -- as
 * the per-image bound and quoted its 120s schema default, when the real bound
 * is the hard-coded 300s `AI_ANALYSIS_LONG`. That schema entry has since been
 * deleted, so the key must now appear in neither the code nor the prose. The
 * extractor paragraph put the 500k-character output cap inside a "configurable
 * under Processing limits" parenthetical when it is a module constant, and
 * named a settings path that only exists in Advanced mode.
 *
 * Every expected value is derived from the real locked sources
 * (performanceConstants, defaultSettings, securityConfig, settingsSearch, and
 * the two analysis modules' own text) rather than restated, so wiring a
 * per-image timeout setting up, changing `AI_ANALYSIS_LONG`, promoting
 * `MAX_TEXT_LENGTH` to a setting, or ungating the Processing limits panel fails
 * this test until the prose is updated too.
 */

// test-setup.js replaces fs with memfs; this suite reads real repo files.
const fs = jest.requireActual('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const { TIMEOUTS } = require('../src/shared/performanceConstants');
const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');
const { SETTINGS_VALIDATION } = require('../src/shared/securityConfig');
const { SETTINGS_SECTION_INDEX } = require('../src/shared/settingsSearch');

const readSrc = (/** @type {string} */ rel) => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');

const architectureDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');

const sectionCache = new Map();

/**
 * Body of a `#### <heading>` section, prose-wrap collapsed to one line.
 *
 * Throws (rather than asserting) on a missing heading so that it is safe to
 * call from inside a test body only -- never at describe-collection time,
 * where a renamed heading would surface as an unattributed collection error
 * instead of a named failing test.
 */
function section(heading) {
  if (!sectionCache.has(heading)) {
    const marker = `#### ${heading}`;
    const start = architectureDoc.indexOf(marker);
    if (start < 0) {
      throw new Error(
        `docs/ARCHITECTURE.md no longer has a "${marker}" heading. ` +
          'This suite pins prose in that section to the code it describes; ' +
          'update the heading name here if the section was renamed.'
      );
    }
    const rest = architectureDoc.slice(start + marker.length);
    const end = rest.indexOf('\n#');
    const body = end === -1 ? rest : rest.slice(0, end);
    sectionCache.set(heading, body.replace(/\s+/g, ' ').trim());
  }
  return sectionCache.get(heading);
}

/** Every .js/.jsx under src/, so "nothing reads this key" is checkable. */
function allSourceFiles(dir, acc) {
  const files = acc || [];
  for (const entry of fs.readdirSync(dir || SRC_ROOT, { withFileTypes: true })) {
    const full = path.join(dir || SRC_ROOT, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      allSourceFiles(full, files);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('docs/ARCHITECTURE.md VisionService per-image timeout (C8)', () => {
  test('the section this suite pins still exists', () => {
    expect(section('VisionService')).toContain('per-image timeout');
  });

  test('the real per-image bound is the hard-coded AI_ANALYSIS_LONG', () => {
    // The premise of the prose: imageAnalysis.js pins the vision timeout to
    // AI_ANALYSIS_LONG instead of reading any setting.
    const imageAnalysisSrc = readSrc(path.join('main', 'analysis', 'imageAnalysis.js'));
    expect(imageAnalysisSrc).toMatch(/timeout:\s*TIMEOUTS\.AI_ANALYSIS_LONG/);
    expect(TIMEOUTS.AI_ANALYSIS_LONG).toBe(300000);
  });

  test('the doc names that timeout, in seconds, as THE per-image timeout', () => {
    const seconds = TIMEOUTS.AI_ANALYSIS_LONG / 1000;
    expect(section('VisionService')).toMatch(
      new RegExp(`per-image timeout is the ${seconds}s \`AI_ANALYSIS_LONG\``, 'i')
    );
  });

  test('the doc presents no config key as a per-image timeout knob', () => {
    const vision = section('VisionService');
    // `imageAnalysisTimeout` was deleted from CONFIG_SCHEMA; the prose must
    // not resurrect the name, as a knob or otherwise.
    expect(vision).not.toMatch(/imageAnalysisTimeout/);
    // The dead schema default (120s) must not be quoted as a live bound. 120s
    // is also the legitimate VISION_STARTUP figure, so scope the check to the
    // per-image sentence, which ends where VISION_STARTUP is introduced.
    const perImageStart = vision.search(/per-image timeout/i);
    const startupStart = vision.search(/`VISION_STARTUP`/);
    expect(perImageStart).toBeGreaterThanOrEqual(0);
    expect(startupStart).toBeGreaterThan(perImageStart);
    const perImageSentence = vision.slice(perImageStart, startupStart);
    expect(perImageSentence).not.toMatch(/120s/);
    expect(perImageSentence).toMatch(/no setting that shortens it/i);
  });

  test('no per-image timeout key is declared or read anywhere under src/', () => {
    const mentions = allSourceFiles()
      .filter((file) => fs.readFileSync(file, 'utf8').includes('imageAnalysisTimeout'))
      .map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    // The only permitted mention is the "do not re-add this" note left in the
    // schema where the dead entry used to be.
    expect(mentions).toEqual(['src/shared/config/configSchema.js']);
    // ...and that mention must stay a comment: no declaration, no reader. If
    // the key is ever wired up for real, this fails and the VisionService
    // paragraph above has to stop saying there is no such setting.
    const codeLines = readSrc(path.join('shared', 'config', 'configSchema.js'))
      .split('\n')
      .filter((line) => line.includes('imageAnalysisTimeout'))
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
    expect(codeLines).toEqual([]);
  });

  test('VISION_REQUEST is only a fallback default, as the doc now says', () => {
    const visionServiceSrc = readSrc(path.join('main', 'services', 'VisionService.js'));
    expect(visionServiceSrc).toMatch(/DEFAULT_REQUEST_TIMEOUT_MS\s*=\s*TIMEOUTS\.VISION_REQUEST/);
    expect(section('VisionService')).toMatch(
      new RegExp('`VISION_REQUEST` \\(' + TIMEOUTS.VISION_REQUEST / 1000 + 's\\)')
    );
  });
});

describe('docs/ARCHITECTURE.md extraction limits (U3)', () => {
  test('the section this suite pins still exists', () => {
    expect(section('Document Extractors')).toMatch(/\(configurable/);
  });

  test('the three documented file-size limits are genuinely user-settable', () => {
    const extractors = section('Document Extractors');
    const configurable = {
      maxImageFileSize: 100 * 1024 * 1024,
      maxDocumentFileSize: 200 * 1024 * 1024,
      maxTextFileSize: 50 * 1024 * 1024
    };
    for (const key of Object.keys(configurable)) {
      const bytes = configurable[key];
      expect(DEFAULT_SETTINGS[key]).toBe(bytes);
      expect(SETTINGS_VALIDATION.allowedKeys.has(key)).toBe(true);
      expect(extractors).toContain(`${bytes / 1024 / 1024} MB`);
    }
  });

  test('the documented settings path is qualified with the mode that shows it', () => {
    // The Processing limits panel renders only behind effectiveAdvancedMode
    // (SettingsPanel.jsx), which tracks this advancedOnly flag. A simple-mode
    // user following an unqualified path would find nothing there.
    const processingLimits = SETTINGS_SECTION_INDEX.find(
      (/** @type {{ title: string }} */ s) => s.title === 'Processing limits'
    );
    expect(processingLimits).toBeDefined();
    expect(processingLimits.advancedOnly).toBe(true);
    expect(section('Document Extractors')).toMatch(
      /configurable in Advanced mode under Settings . Performance . Processing limits/
    );
  });

  test('the 500k char output cap is documented as hard-coded, not configurable', () => {
    const extractors = section('Document Extractors');
    const documentExtractorsSrc = readSrc(path.join('main', 'analysis', 'documentExtractors.js'));
    const declared = documentExtractorsSrc.match(/const MAX_TEXT_LENGTH = (\d+);/);
    expect(declared).not.toBeNull();
    const chars = Number(declared[1]);
    expect(chars).toBe(500000);
    // It is a module constant, not a setting...
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('maxTextLength');
    expect(SETTINGS_VALIDATION.allowedKeys.has('maxTextLength')).toBe(false);
    // ...so the doc must say so, and must not fold it into the
    // "configurable ... Processing limits" parenthetical.
    expect(extractors).toMatch(
      new RegExp(`${chars / 1000}k-character cap on extracted text is a hard-coded constant`, 'i')
    );
    const configurableClause = extractors.match(/\(configurable[^)]*\)/);
    expect(configurableClause).not.toBeNull();
    expect(configurableClause[0]).not.toMatch(/char/i);
  });
});
