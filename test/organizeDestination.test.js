/**
 * Organize destination precedence (D1): the user's choice, then the
 * suggestion engine's ranked primary, then name matching (fallback 2).
 */

import {
  normalizeEngineEntry,
  findFolderForCandidate,
  resolveOrganizeDestination,
  suggestionForOperation
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
