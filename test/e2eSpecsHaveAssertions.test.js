/**
 * Meta-test: every Playwright E2E spec must assert at least something.
 *
 * Rationale: Tests that merely call `console.log(...)` without `expect(...)`
 * pass silently and give zero regression coverage while counting toward the
 * E2E total. This file prevents that pattern from being added back.
 *
 * The test scans `test/e2e/**\/*.spec.js` and, per `test(...)` block, requires
 * at least one `expect(` token OR a known assertion helper OR an allowlisted
 * exception (legacy log-only blocks documented below). New assertion-free
 * blocks must be added to ASSERTIONLESS_ALLOWLIST explicitly.
 */

// test-setup.js mocks `fs` with memfs for the rest of the suite. This
// meta-test needs to read the actual on-disk E2E spec files, so grab the
// real fs via requireActual.
const fs = jest.requireActual('fs');
const path = require('path');

const E2E_DIR = path.join(__dirname, 'e2e');

/**
 * Helpers that wrap `expect(...)` outside the test body. A call to one of
 * these is treated as an assertion for the enclosing block.
 */
const ASSERTION_HELPERS = ['auditCurrentScreen', 'expectNoA11yViolations'];

/**
 * Legacy log-only (or helper-free) blocks. Keys are `${posixRel}::${title}`.
 * Prefer adding assertions to new specs rather than growing this list.
 */
const ASSERTIONLESS_ALLOWLIST = new Set([
  'test/e2e/analysis-history.spec.js::should have history access in settings',
  'test/e2e/analysis-history.spec.js::should have history access from Discover phase',
  'test/e2e/beta-workflow.spec.js::should close search modal with Escape',
  'test/e2e/beta-workflow.spec.js::should close settings panel',
  'test/e2e/chat-understand.spec.js::should close Knowledge Graph chat with Escape',
  'test/e2e/file-import.spec.js::should show file selection instructions',
  'test/e2e/file-import.spec.js::should display supported file types information',
  'test/e2e/file-import.spec.js::should have folder selection option',
  'test/e2e/file-import.spec.js::should show analyze button (may be disabled initially)',
  'test/e2e/file-import.spec.js::should show file count indicator',
  'test/e2e/file-import.spec.js::should have selection controls',
  'test/e2e/keyboard-navigation.spec.js::should navigate backwards with Shift+Tab',
  'test/e2e/keyboard-navigation.spec.js::should show visible focus indicators',
  'test/e2e/keyboard-navigation.spec.js::should activate buttons with Enter key',
  'test/e2e/keyboard-navigation.spec.js::should activate buttons with Space key',
  'test/e2e/keyboard-navigation.spec.js::should close search modal with Escape',
  'test/e2e/keyboard-navigation.spec.js::should close dropdowns with Escape',
  'test/e2e/keyboard-navigation.spec.js::should move forward with Alt+Right',
  'test/e2e/keyboard-navigation.spec.js::should open search with Ctrl+K',
  'test/e2e/keyboard-navigation.spec.js::should check canUndo state',
  'test/e2e/keyboard-navigation.spec.js::should check canRedo state',
  'test/e2e/keyboard-navigation.spec.js::should support Ctrl+A in text inputs',
  'test/e2e/keyboard-navigation.spec.js::should navigate lists with arrow keys',
  'test/e2e/keyboard-navigation.spec.js::should support Home/End in lists',
  'test/e2e/knowledge-graph.spec.js::should have clusters toggle button',
  'test/e2e/last-browsed-path.spec.js::should have folder selection option available',
  'test/e2e/last-browsed-path.spec.js::should validate lastBrowsedPath as string type',
  'test/e2e/last-browsed-path.spec.js::should handle very long paths',
  'test/e2e/menu-shortcuts.spec.js::should have search shortcut Ctrl+K',
  'test/e2e/notifications.spec.js::should have notification container in DOM',
  'test/e2e/notifications.spec.js::should have notification API available',
  'test/e2e/notifications.spec.js::should display notification container when triggered',
  'test/e2e/notifications.spec.js::should support info notification style',
  'test/e2e/notifications.spec.js::should support success notification style',
  'test/e2e/notifications.spec.js::should support warning notification style',
  'test/e2e/notifications.spec.js::should support error notification style',
  'test/e2e/notifications.spec.js::should auto-dismiss notifications after timeout',
  'test/e2e/notifications.spec.js::should have dismiss button on notifications',
  'test/e2e/notifications.spec.js::should stack multiple notifications',
  'test/e2e/notifications.spec.js::should position notifications correctly',
  'test/e2e/notifications.spec.js::should show error notification on API failure',
  'test/e2e/notifications.spec.js::should show notification on connection status change',
  'test/e2e/notifications.spec.js::should show notification on settings save success',
  'test/e2e/notifications.spec.js::should have proper ARIA role on notifications',
  'test/e2e/notifications.spec.js::should be announced to screen readers',
  'test/e2e/organize-phase.spec.js::should show Organize button state correctly',
  'test/e2e/organize-phase.spec.js::should show empty state when no files',
  'test/e2e/organize-phase.spec.js::should have smart folders button when folders configured',
  'test/e2e/organize-phase.spec.js::should have undo/redo toolbar when on Organize phase',
  'test/e2e/organize-phase.spec.js::should have file organization API available',
  'test/e2e/organize-phase.spec.js::should open status overview modal',
  'test/e2e/organize-phase.spec.js::should open smart folders modal when available',
  'test/e2e/search-modal.spec.js::should close search with Escape',
  'test/e2e/search-modal.spec.js::should have search API available',
  'test/e2e/search-modal.spec.js::should clear search on modal close',
  'test/e2e/search-modal.spec.js::should have semantic search mode option',
  'test/e2e/search-modal.spec.js::should have full-text search mode option',
  'test/e2e/search-modal.spec.js::should have hybrid search mode option',
  'test/e2e/search-modal.spec.js::should have results container',
  'test/e2e/search-modal.spec.js::should show similarity scores in results',
  'test/e2e/search-modal.spec.js::should support clicking on search results',
  'test/e2e/search-modal.spec.js::should show indexed files count',
  'test/e2e/search-modal.spec.js::should be able to get embedding stats',
  'test/e2e/search-modal.spec.js::should navigate results with arrow keys',
  'test/e2e/search-modal.spec.js::should select result with Enter key',
  'test/e2e/search-modal.spec.js::should support Tab navigation within modal',
  'test/e2e/search-modal.spec.js::should display graph container when tab is active',
  'test/e2e/search-modal.spec.js::should have graph controls when in graph view',
  'test/e2e/search-modal.spec.js::should be able to perform a search',
  'test/e2e/search-modal.spec.js::should have refresh button for rebuilding index',
  'test/e2e/search-modal.spec.js::should have Select All button in search results',
  'test/e2e/search-modal.spec.js::should have Copy Selected Paths button',
  'test/e2e/search-modal.spec.js::should have Move Selected Files option',
  'test/e2e/search-modal.spec.js::should have checkbox UI for result selection',
  'test/e2e/search-modal.spec.js::should display match reason in search results',
  'test/e2e/search-modal.spec.js::should show search mode indicator',
  'test/e2e/search-modal.spec.js::should have cluster visualization in graph view',
  'test/e2e/search-modal.spec.js::should have Create Smart Folder option for clusters',
  'test/e2e/search-modal.spec.js::should have action buttons in graph node UI',
  'test/e2e/smart-folders.spec.js::should open add folder modal',
  'test/e2e/smart-folders.spec.js::should have folder name input in modal',
  'test/e2e/smart-folders.spec.js::should have folder path input or browse button',
  'test/e2e/smart-folders.spec.js::should have keywords input',
  'test/e2e/smart-folders.spec.js::should have description input',
  'test/e2e/smart-folders.spec.js::should have save and cancel buttons',
  'test/e2e/smart-folders.spec.js::should have edit button on folder items',
  'test/e2e/smart-folders.spec.js::should open edit modal when clicking edit',
  'test/e2e/smart-folders.spec.js::should have delete button on folder items',
  'test/e2e/smart-folders.spec.js::should show confirmation before delete',
  'test/e2e/smart-folders.spec.js::should have Continue button',
  'test/e2e/undo-redo.spec.js::should check canUndo state',
  'test/e2e/undo-redo.spec.js::should check canRedo state',
  'test/e2e/undo-redo.spec.js::should get empty history initially',
  'test/e2e/undo-redo.spec.js::should have undo menu item in Edit menu',
  'test/e2e/undo-redo.spec.js::should have redo menu item in Edit menu',
  'test/e2e/undo-redo.spec.js::should have history viewer option',
  'test/e2e/window-state.spec.js::should toggle fullscreen with F11'
]);

function findMatchingParen(s, openIdx) {
  let depth = 0;
  let inS = null;
  let escaped = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\' && inS !== '`') {
        escaped = true;
        continue;
      }
      if (c === inS) inS = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inS = c;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length - 1 : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length - 1 : end + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractNamedTestBlocks(content) {
  const regex = /(?<![A-Za-z0-9_$.])(?:it|test)(?:\.(?:skip|only|fixme))?\s*\(/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingParen(content, openParen);
    if (closeParen === -1) continue;
    const body = content.slice(match.index, closeParen + 1);
    const nameMatch = body.match(
      /^(?:it|test)(?:\.(?:skip|only|fixme))?\s*\(\s*(['"`])([\s\S]*?)\1/
    );
    if (!nameMatch) continue;
    blocks.push({
      name: nameMatch[2].replace(/\s+/g, ' '),
      body
    });
  }
  return blocks;
}

function blockHasAssertion(body) {
  if (/\bexpect\s*\(|\bexpect\./.test(body)) return true;
  return ASSERTION_HELPERS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));
}

function listSpecs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSpecs(p));
    } else if (entry.isFile() && p.endsWith('.spec.js')) {
      out.push(p);
    }
  }
  return out;
}

function allowlistKey(rel, title) {
  return `${rel.replace(/\\/g, '/')}::${title}`;
}

describe('per-block assertion extractor', () => {
  test('flags a test block with no expect unless it uses a helper', () => {
    const fixture = `
      test('has assertion', async () => {
        expect(1).toBe(1);
      });
      test('log only', async () => {
        console.log('ready');
      });
      test('helper assertion', async () => {
        await auditCurrentScreen(page, 'initial');
      });
    `;
    const blocks = extractNamedTestBlocks(fixture);
    expect(blocks.map((b) => b.name)).toEqual(['has assertion', 'log only', 'helper assertion']);
    expect(blockHasAssertion(blocks[0].body)).toBe(true);
    expect(blockHasAssertion(blocks[1].body)).toBe(false);
    expect(blockHasAssertion(blocks[2].body)).toBe(true);
  });

  test('does not treat a file-level expect as covering later blocks', () => {
    const fixture = `
      const n = expect.getState ? 1 : 0;
      test('first asserts', () => { expect(n).toBe(1); });
      test('second is log only', () => { console.log(n); });
    `;
    const blocks = extractNamedTestBlocks(fixture);
    expect(blocks).toHaveLength(2);
    expect(blockHasAssertion(blocks[0].body)).toBe(true);
    expect(blockHasAssertion(blocks[1].body)).toBe(false);
  });
});

describe('E2E specs must assert per block', () => {
  const specs = listSpecs(E2E_DIR);

  test('E2E directory has at least one spec', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  specs.forEach((specPath) => {
    const rel = path.relative(path.join(__dirname, '..'), specPath).replace(/\\/g, '/');
    test(`${rel}: every named test() block asserts or is allowlisted`, () => {
      const content = fs.readFileSync(specPath, 'utf8');
      const blocks = extractNamedTestBlocks(content);
      if (blocks.length === 0) return;

      const missing = blocks
        .filter((block) => !blockHasAssertion(block.body))
        .filter((block) => !ASSERTIONLESS_ALLOWLIST.has(allowlistKey(rel, block.name)))
        .map((block) => block.name);

      expect(missing).toEqual([]);
    });
  });

  test('ASSERTIONLESS_ALLOWLIST only names blocks that exist and are still assertion-free', () => {
    const repoRoot = path.join(__dirname, '..');
    const blocksBySpec = new Map();
    const liveAssertionlessKeys = new Set();
    for (const specPath of specs) {
      const rel = path.relative(repoRoot, specPath).replace(/\\/g, '/');
      const blocks = extractNamedTestBlocks(fs.readFileSync(specPath, 'utf8'));
      blocksBySpec.set(rel, blocks);
      for (const block of blocks) {
        if (!blockHasAssertion(block.body))
          liveAssertionlessKeys.add(allowlistKey(rel, block.name));
      }
    }

    const stale = [...ASSERTIONLESS_ALLOWLIST]
      .filter((key) => !liveAssertionlessKeys.has(key))
      .map((key) => {
        const [rel, title] = key.split(/::(.*)/s);
        const blocks = blocksBySpec.get(rel);
        if (!blocks) return `${key} (spec file missing)`;
        if (!blocks.some((b) => b.name === title)) return `${key} (test block missing)`;
        return `${key} (block now asserts — remove from allowlist)`;
      });

    expect(stale).toEqual([]);
  });
});
