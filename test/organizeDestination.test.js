/**
 * Organize destination precedence (D1): the user's choice, then the
 * suggestion engine's ranked primary, then name matching (fallback 2).
 */

import {
  normalizeEngineEntry,
  findFolderForCandidate,
  resolveOrganizeDestination,
  suggestionForOperation,
  describeRouting,
  routingScore,
  isStaleDestination,
  findStaleFiles
} from '../src/renderer/phases/organize/organizeDestination';

const FINANCE = { id: 'f-fin', name: 'Finance', path: '/library/Finance' };
const TAXES = { id: 'f-tax', name: 'Taxes', path: '/library/Taxes' };
const ACME = { id: 'f-acme', name: 'Acme Inc', path: '/library/Acme Inc' };
const UNCATEGORIZED = { id: 'f-unc', name: 'Uncategorized', path: '/library/Uncategorized' };
const FOLDERS = [FINANCE, TAXES, ACME, UNCATEGORIZED];

const byName = (label) =>
  FOLDERS.find((f) => f.name.toLowerCase() === String(label || '').toLowerCase()) || null;
const byVendor = (file) => (file?.analysis?.vendor === 'Acme' ? ACME : null);

function engineFor(folder, extra = {}) {
  return normalizeEngineEntry({
    path: '/in/doc.pdf',
    suggestion: { ...folder, folder: folder.name, folderId: folder.id, isSmartFolder: true },
    confidence: 0.82,
    explanation: `This file's meaning matches "${folder.name}"`,
    alternatives: [],
    ...extra
  });
}

function resolve({ analysis = {}, edits = null, engine = null } = {}) {
  return resolveOrganizeDestination({
    fileWithEdits: { path: '/in/doc.pdf', name: 'doc.pdf', analysis },
    edits,
    engineSuggestion: engine,
    smartFolders: FOLDERS,
    findSmartFolderForCategory: byName,
    findSmartFolderForFile: byVendor
  });
}

describe('resolveOrganizeDestination', () => {
  test('the engine outranks the label when the label names another folder', () => {
    const result = resolve({ analysis: { category: 'Taxes' }, engine: engineFor(FINANCE) });
    expect(result.folder).toBe(FINANCE);
    expect(result.source).toBe('engine');
  });

  test('a card edit outranks the engine', () => {
    const result = resolve({
      analysis: { category: 'Taxes' },
      edits: { category: 'Taxes' },
      engine: engineFor(FINANCE)
    });
    expect(result.folder).toBe(TAXES);
    expect(result.source).toBe('user');
  });

  test('a choice kept from an earlier visit (userCategory) outranks the engine', () => {
    const result = resolve({
      analysis: { category: 'Taxes', userCategory: 'Taxes' },
      engine: engineFor(FINANCE)
    });
    expect(result.folder).toBe(TAXES);
    expect(result.source).toBe('user');
  });

  test('name matching is the fallback when the engine has nothing', () => {
    const result = resolve({ analysis: { category: 'Taxes' } });
    expect(result.folder).toBe(TAXES);
    expect(result.source).toBe('name');
  });

  test('an engine pick of Uncategorized loses to a name match', () => {
    const result = resolve({
      analysis: { category: 'Uncategorized', vendor: 'Acme' },
      engine: engineFor(UNCATEGORIZED)
    });
    expect(result.folder).toBe(ACME);
    expect(result.source).toBe('name');
  });

  test('an engine pick of Uncategorized still stands when nothing else matches', () => {
    const result = resolve({
      analysis: { category: 'Nonsense' },
      engine: engineFor(UNCATEGORIZED)
    });
    expect(result.folder).toBe(UNCATEGORIZED);
    expect(result.source).toBe('engine');
  });

  test('a candidate for a folder that no longer exists falls through to name matching', () => {
    const gone = normalizeEngineEntry({
      path: '/in/doc.pdf',
      suggestion: { folder: 'Old', path: '/library/Old', folderId: 'gone', isSmartFolder: true }
    });
    const result = resolve({ analysis: { category: 'Taxes' }, engine: gone });
    expect(result.folder).toBe(TAXES);
    expect(result.source).toBe('name');
  });

  test('nothing matches: no folder, so the caller uses Uncategorized', () => {
    const result = resolve({ analysis: { category: 'Nonsense' } });
    expect(result.folder).toBeNull();
    expect(result.source).toBe('none');
  });
});

describe('normalizeEngineEntry', () => {
  test('keeps only smart-folder candidates with a path, deduplicated', () => {
    const entry = normalizeEngineEntry({
      suggestion: { folder: 'Finance', path: '/library/Finance', isSmartFolder: true },
      confidence: 0.7,
      explanation: '  why  ',
      alternatives: [
        { folder: 'Taxes', path: '/library/Taxes', isSmartFolder: true, confidence: 0.5 },
        { folder: 'Finance', path: '/library/Finance', isSmartFolder: true },
        { folder: 'Ghost', path: '/library/Ghost', unresolvedSmartFolder: true },
        { folder: 'Nowhere', isSmartFolder: true },
        { folder: 'Web', path: '/x', isSmartFolder: false }
      ]
    });
    expect(entry.folder).toBe('Finance');
    expect(entry.confidence).toBe(0.7);
    expect(entry.explanation).toBe('why');
    expect(entry.alternatives.map((a) => a.folder)).toEqual(['Taxes']);
  });

  test('returns null when the primary is not a placeable smart folder', () => {
    expect(normalizeEngineEntry({ suggestion: { folder: 'X', isSmartFolder: true } })).toBeNull();
    expect(normalizeEngineEntry({ suggestion: null })).toBeNull();
  });

  test('percent confidences become 0..1', () => {
    const entry = normalizeEngineEntry({
      suggestion: { folder: 'Finance', path: '/library/Finance' },
      confidence: 64
    });
    expect(entry.confidence).toBeCloseTo(0.64);
  });
});

describe('a file the engine marks as needing review', () => {
  const REVIEW_TEXT = 'No Smart Folder matched this file well. The closest was "Taxes".';

  function reviewEngine(withDefault = true) {
    return normalizeEngineEntry({
      path: '/in/doc.pdf',
      suggestion: withDefault
        ? {
            ...UNCATEGORIZED,
            folder: UNCATEGORIZED.name,
            folderId: UNCATEGORIZED.id,
            isSmartFolder: true,
            source: 'default'
          }
        : null,
      confidence: withDefault ? 0.1 : 0,
      explanation: REVIEW_TEXT,
      alternatives: [{ ...TAXES, folder: TAXES.name, folderId: TAXES.id, isSmartFolder: true }],
      needsReview: true,
      routingDecision: { reason: 'weak_match' }
    });
  }

  test('stays in the default folder; name matching does not pick one', () => {
    const result = resolve({
      analysis: { category: 'Taxes', vendor: 'Acme' },
      engine: reviewEngine()
    });
    expect(result.source).toBe('review');
    expect(result.folder).toBe(UNCATEGORIZED);
    expect(result.engine.explanation).toBe(REVIEW_TEXT);
    expect(result.engine.reviewReason).toBe('weak_match');
    expect(result.engine.alternatives.map((a) => a.folder)).toEqual(['Taxes']);
  });

  test('keeps the closest folder so held files can be offered it in bulk', () => {
    const engine = normalizeEngineEntry({
      path: '/in/export.xlsx',
      suggestion: null,
      needsReview: true,
      routingDecision: {
        reason: 'weak_match',
        best: { folder: ' Taxes ', score: 0.48 },
        runnerUp: { folder: 'Receipts', score: 0.41 }
      }
    });
    expect(engine.reviewClosest).toBe('Taxes');
    // Both scores travel, so the bulk offer can skip a near-tie.
    expect(engine.reviewClosestScore).toBe(0.48);
    expect(engine.reviewRunnerUpScore).toBe(0.41);
    // A routed file carries no closest folder: only held files are offered one.
    const routed = normalizeEngineEntry({
      path: '/in/doc.pdf',
      suggestion: { ...TAXES, folder: TAXES.name, folderId: TAXES.id, isSmartFolder: true },
      confidence: 0.8,
      routingDecision: { best: { folder: 'Taxes', score: 0.8 } }
    });
    expect(routed.reviewClosest).toBeUndefined();
  });

  test('with no default folder it stays unassigned', () => {
    const engine = reviewEngine(false);
    expect(engine).not.toBeNull();
    expect(engine.needsReview).toBe(true);
    expect(engine.folder).toBeNull();
    const result = resolve({ analysis: { category: 'Taxes' }, engine });
    expect(result.source).toBe('review');
    expect(result.folder).toBeNull();
  });

  test('the user can still pick a folder', () => {
    const result = resolve({
      analysis: { category: 'Taxes' },
      edits: { category: 'Finance' },
      engine: reviewEngine()
    });
    expect(result.source).toBe('user');
    expect(result.folder).toBe(FINANCE);
  });
});

describe('findFolderForCandidate', () => {
  test('matches by id first, then by path', () => {
    expect(findFolderForCandidate({ folderId: 'f-tax', path: '/elsewhere' }, FOLDERS)).toBe(TAXES);
    expect(findFolderForCandidate({ folderId: null, path: '/library/Finance' }, FOLDERS)).toBe(
      FINANCE
    );
  });
});

describe('suggestionForOperation', () => {
  test('carries the engine folder, whatever the user picked', () => {
    const destination = resolve({
      analysis: { category: 'Taxes' },
      edits: { category: 'Taxes' },
      engine: engineFor(FINANCE)
    });
    expect(suggestionForOperation(destination, FOLDERS)).toEqual({
      folder: 'Finance',
      path: '/library/Finance',
      source: 'engine'
    });
  });

  test('no suggestion for a file that needs review, even from a non-generic default', () => {
    const INBOX = { id: 'f-inbox', name: 'Inbox', path: '/library/Inbox' };
    const engine = normalizeEngineEntry({
      path: '/in/doc.pdf',
      suggestion: { ...INBOX, folder: 'Inbox', folderId: INBOX.id, isSmartFolder: true },
      confidence: 0.1,
      needsReview: true
    });
    const destination = resolveOrganizeDestination({
      fileWithEdits: { path: '/in/doc.pdf', name: 'doc.pdf', analysis: {} },
      edits: { category: 'Finance' },
      engineSuggestion: engine,
      smartFolders: [...FOLDERS, INBOX],
      findSmartFolderForCategory: byName,
      findSmartFolderForFile: byVendor
    });
    expect(destination.source).toBe('user');
    expect(suggestionForOperation(destination, [...FOLDERS, INBOX])).toBe(undefined);
  });

  test('no suggestion for a name match or a generic-bucket engine pick', () => {
    expect(suggestionForOperation(resolve({ analysis: { category: 'Taxes' } }), FOLDERS)).toBe(
      undefined
    );
    expect(
      suggestionForOperation(
        resolve({ analysis: { category: 'Nonsense' }, engine: engineFor(UNCATEGORIZED) }),
        FOLDERS
      )
    ).toBe(undefined);
  });
});

describe('describeRouting and routingScore', () => {
  test('an engine pick gives its reason and its score', () => {
    const routing = resolve({ analysis: { category: 'Taxes' }, engine: engineFor(FINANCE) });
    expect(describeRouting(routing, 'Taxes')).toBe('This file\'s meaning matches "Finance"');
    expect(routingScore(routing)).toBe(0.82);
  });

  test('a label match says so, with no score', () => {
    const routing = resolve({ analysis: { category: 'Taxes' } });
    expect(describeRouting(routing, 'Taxes')).toBe(
      'Matched by the label the analysis gave this file'
    );
    expect(routingScore(routing)).toBeNull();
  });

  test('the user choice names the engine pick it overrode, with no score', () => {
    const routing = resolve({ edits: { category: 'Taxes' }, engine: engineFor(FINANCE) });
    expect(describeRouting(routing, 'Taxes')).toBe('Your choice (suggested: Finance)');
    expect(routingScore(routing)).toBeNull();
  });

  test('no destination has no reason', () => {
    expect(describeRouting(resolve({ analysis: { category: 'Nonsense' } }), 'Nonsense')).toBe(null);
  });
});

describe('stale results: picked under Smart Folder definitions that changed', () => {
  const NOW = 'sf-current';
  const file = (analysis) => ({ path: '/Users/alex/in/doc.pdf', name: 'doc.pdf', analysis });

  test('a label match from old definitions is stale', () => {
    const stale = file({ category: 'Taxes', smartFolderHash: 'sf-old' });
    const routing = resolve({ analysis: stale.analysis });
    expect(routing.source).toBe('name');
    expect(isStaleDestination(stale, routing, NOW)).toBe(true);
  });

  test('no folder from an old label is stale too: the new folders may place it', () => {
    const stale = file({ category: 'Nonsense', smartFolderHash: 'sf-old' });
    const routing = resolve({ analysis: stale.analysis });
    expect(routing.source).toBe('none');
    expect(isStaleDestination(stale, routing, NOW)).toBe(true);
  });

  test('an engine pick is current: it was ranked with the current folders', () => {
    const stale = file({ category: 'Taxes', smartFolderHash: 'sf-old' });
    const routing = resolve({ analysis: stale.analysis, engine: engineFor(FINANCE) });
    expect(isStaleDestination(stale, routing, NOW)).toBe(false);
  });

  test('the user choice is never stale', () => {
    const stale = file({ category: 'Taxes', userCategory: 'Taxes', smartFolderHash: 'sf-old' });
    const routing = resolve({ analysis: stale.analysis });
    expect(routing.source).toBe('user');
    expect(isStaleDestination(stale, routing, NOW)).toBe(false);
  });

  test('analysis under the current definitions, or with no stamp, is not stale', () => {
    const current = file({ category: 'Taxes', smartFolderHash: NOW });
    const unstamped = file({ category: 'Taxes' });
    expect(isStaleDestination(current, resolve({ analysis: current.analysis }), NOW)).toBe(false);
    expect(isStaleDestination(unstamped, resolve({ analysis: unstamped.analysis }), NOW)).toBe(
      false
    );
  });

  test('findStaleFiles keeps only the stale ones', () => {
    const a = { ...file({ category: 'Taxes', smartFolderHash: 'sf-old' }), path: '/a.pdf' };
    const b = { ...file({ category: 'Taxes', smartFolderHash: NOW }), path: '/b.pdf' };
    const c = { path: '/c.pdf', name: 'c.pdf' }; // not analyzed
    const resolveFile = (f) => resolve({ analysis: f.analysis || {} });
    expect(findStaleFiles([a, b, c], resolveFile, NOW)).toEqual([a]);
    expect(findStaleFiles([a, b, c], resolveFile, '')).toEqual([]);
  });
});
