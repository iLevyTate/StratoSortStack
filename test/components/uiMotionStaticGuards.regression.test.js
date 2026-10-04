/**
 * Static UI-polish ratchets (J-001, J-002, J-004).
 *
 * These guards scan renderer source because the defects they pin are
 * class-vocabulary mistakes that render fine in jsdom (no computed styles)
 * and only break in the real app:
 *
 * - J-002: `animate-in` / `fade-in` / `zoom-in-*` / `slide-in-from-*` come
 *   from the `tailwindcss-animate` plugin, which this project does NOT
 *   install — the classes compile to nothing and silently claim motion that
 *   never runs (verified absent from dist/styles.css).
 * - J-001: controls hidden with `opacity-0` + revealed via
 *   `group-hover:opacity-100` are still keyboard-focusable while invisible;
 *   every such site must also reveal on keyboard focus
 *   (`group-focus-within:opacity-100` or `focus-visible:opacity-100`),
 *   matching the established ResultRow/TriageModal pattern.
 * - J-004 / U-T13: docs/MOTION_SYSTEM.md — "Transition only required
 *   properties … Avoid transition-all for frequently used controls." The
 *   hot-path files fixed in the J sweep (J-004) and the six remaining graph /
 *   organize / undo controls narrowed in U-T13 must not regress to
 *   `transition-all`; each now names the exact property set it animates.
 */

// The suite-wide fs mock is memfs — scan the real repository tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const RENDERER_ROOT = path.join(__dirname, '..', '..', 'src', 'renderer');

function walkSourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, files);
    } else if (/\.(jsx|js)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function stripLineComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const rendererFiles = walkSourceFiles(RENDERER_ROOT);

describe('dead tailwindcss-animate vocabulary is banned (J-002)', () => {
  // Standalone tokens only: `animate-fade-in` (a real app utility) must not
  // match the banned bare `fade-in`.
  const DEAD_TOKEN_PATTERNS = [
    /(?<![\w-])animate-in(?![\w-])/,
    /(?<![\w-])fade-in(?![\w-])/,
    /(?<![\w-])zoom-in-\d+(?![\w-])/,
    /(?<![\w-])slide-in-from-[\w-]+/
  ];

  test('no renderer source uses animate-in / fade-in / zoom-in-* / slide-in-from-*', () => {
    const offenders = [];
    for (const file of rendererFiles) {
      const source = stripLineComments(fs.readFileSync(file, 'utf8'));
      for (const pattern of DEAD_TOKEN_PATTERNS) {
        const match = source.match(pattern);
        if (match) {
          offenders.push(`${path.relative(RENDERER_ROOT, file)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('hover-revealed controls stay reachable for keyboard users (J-001)', () => {
  test('every opacity-0 + group-hover:opacity-100 site also reveals on focus', () => {
    const offenders = [];
    for (const file of rendererFiles) {
      const source = fs.readFileSync(file, 'utf8');
      let index = source.indexOf('group-hover:opacity-100');
      while (index !== -1) {
        const window = source.slice(Math.max(0, index - 300), index + 300);
        const hidesFully = /(?<![\w-])opacity-0(?![\w-])/.test(window);
        const revealsOnFocus =
          window.includes('group-focus-within:opacity-100') ||
          window.includes('focus-within:opacity-100') ||
          window.includes('focus-visible:opacity-100');
        if (hidesFully && !revealsOnFocus) {
          offenders.push(`${path.relative(RENDERER_ROOT, file)} @ char ${index}`);
        }
        index = source.indexOf('group-hover:opacity-100', index + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('transition-all stays off fixed hot paths (J-004 / U-T13)', () => {
  const HOT_PATH_FILES = [
    // J-004 sweep
    'components/discover/AnalysisProgress.jsx',
    'components/organize/OrganizeProgress.jsx',
    'components/organize/ReadyFileItem.jsx',
    'components/organize/DuplicateResolutionModal.jsx',
    'components/triage/DownloadsTriageView.jsx',
    'components/search/KnowledgeEdge.jsx',
    'components/search/ConversationSidebar.jsx',
    'components/search/DocumentScopePanel.jsx',
    'components/search/BaseEdgeTooltip.jsx',
    // U-T13 — the last six, each narrowed to its real animated property set
    'components/search/ClusterNode.jsx',
    'components/search/GraphTour.jsx',
    'components/search/nodes/FileNode.jsx',
    'components/search/SimilarityEdge.jsx',
    'components/organize/OrganizationSuggestions.jsx',
    'components/UndoRedoSystem.jsx'
  ];

  test.each(HOT_PATH_FILES)('%s carries no transition-all', (relativePath) => {
    const source = fs.readFileSync(path.join(RENDERER_ROOT, relativePath), 'utf8');
    expect(source).not.toMatch(/transition-all/);
  });
});

describe('global button cursor (FI-06)', () => {
  test('styles.css restores pointer cursor for enabled buttons app-wide', () => {
    // Tailwind 4 preflight defaults buttons to the arrow cursor; without this
    // base rule, raw buttons look inert next to ui/Button's cursor-pointer.
    const styles = fs.readFileSync(path.join(RENDERER_ROOT, 'styles.css'), 'utf8');
    const ruleStart = styles.indexOf('button:not(:disabled)');
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleBody = styles.slice(ruleStart, styles.indexOf('}', ruleStart));
    expect(ruleBody).toContain('cursor: pointer');
  });
});

describe('restored enter animations use real app utilities (U-T12)', () => {
  // The 13 sites J-002 stripped now carry utilities that actually compile
  // (tailwind.config.js `animation` entries), not tailwindcss-animate names.
  const RESTORED_SITES = [
    ['components/search/BaseEdgeTooltip.jsx', ['animate-pop-in']],
    ['components/search/ChatPanel.jsx', ['animate-slide-down']],
    ['components/search/CitationPreview.jsx', ['animate-pop-in']],
    ['components/search/ClusterNode.jsx', ['animate-slide-up']],
    ['components/search/GraphTour.jsx', ['animate-fade-in', 'animate-pop-in']],
    // The graph tab's enter animations moved with the JSX extraction
    // (UnifiedSearchModal -> GraphTabContent, §I Phase 5b).
    [
      'components/search/GraphTabContent.jsx',
      ['animate-slide-up', 'animate-slide-down', 'animate-fade-in']
    ],
    ['components/search/nodes/FileNode.jsx', ['animate-pop-in']],
    ['components/search/nodes/QueryNode.jsx', ['animate-pop-in']]
  ];

  test.each(RESTORED_SITES)('%s carries its enter-animation utilities', (relativePath, tokens) => {
    const source = fs.readFileSync(path.join(RENDERER_ROOT, relativePath), 'utf8');
    for (const token of tokens) {
      expect(source).toContain(token);
    }
  });

  test('styles.css @theme declares every used animate-* utility (tailwind.config.js is inert)', () => {
    // Tailwind 4 CSS-first build: no @config directive and no config path in
    // postcss.config.js, so tailwind.config.js keyframes compile to NOTHING.
    // Every animate-* utility used in the renderer must have a --animate-*
    // token (and keyframes) in the styles.css @theme block.
    const styles = fs.readFileSync(path.join(RENDERER_ROOT, 'styles.css'), 'utf8');
    for (const name of [
      'fade-in',
      'slide-up',
      'slide-down',
      'slide-in-right',
      'pop-in',
      'confirm-bounce'
    ]) {
      expect(styles).toContain(`--animate-${name}:`);
      expect(styles).toContain(`@keyframes ${name}`);
    }
  });
});
