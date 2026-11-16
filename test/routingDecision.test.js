/**
 * decideRouting: route only to a confident match, otherwise needs review.
 */

const {
  decideRouting,
  findNameMatch,
  NAME_ONLY_MAX_CONFIDENCE
} = require('../src/main/services/organization/routingDecision');

const A = { id: 'a', name: 'Alpha', path: '/Users/alex/L/Alpha' };
const B = { id: 'b', name: 'Beta', path: '/Users/alex/L/Beta' };
const DOCS = { id: 'd', name: 'Documents', path: '/Users/alex/L/Documents' };
const UNC = {
  id: 'u',
  name: 'Uncategorized',
  path: '/Users/alex/L/Uncategorized',
  isDefault: true
};
const FOLDERS = [A, B, UNC];

/** A canonicalized, source-tagged suggestion as the engine builds them. */
const s = (folder, score, source, extra = {}) => ({
  folder: folder.name,
  path: folder.path,
  folderId: folder.id,
  isSmartFolder: true,
  score,
  confidence: score,
  source,
  ...extra
});

const file = (analysis = {}, name = 'notes.md') => ({
  name,
  extension: name.split('.').pop(),
  path: `/Users/alex/Downloads/${name}`,
  analysis
});

test('a template folder in front does not hide a confident content match', () => {
  const strategy = s(B, 0.9, 'strategy', { method: 'strategy_based' });
  const semantic = s(A, 0.7, 'semantic');
  const decision = decideRouting({
    file: file(),
    ranked: [strategy, semantic],
    sourceSuggestions: [strategy, semantic],
    smartFolders: FOLDERS
  });
  expect(decision.needsReview).toBe(false);
  expect(decision.basis).toBe('content_match');
  expect(decision.candidate.folder).toBe('Alpha');
});

test('a feedback rule that lifted the folder counts as learned', () => {
  const semantic = s(A, 0.42, 'semantic', { memoryAdjustment: { boost: 0.1, penalty: 0 } });
  const decision = decideRouting({
    file: file(),
    ranked: [semantic],
    sourceSuggestions: [s(A, 0.42, 'semantic')],
    smartFolders: FOLDERS
  });
  expect(decision.basis).toBe('learned');
});

test('a confident folder ranked second wins over a weaker one in front', () => {
  const llm = s(A, 0.6, 'llm', { method: 'llm_creative' });
  const semantic = s(B, 0.8, 'semantic');
  const decision = decideRouting({
    file: file(),
    ranked: [llm, semantic],
    sourceSuggestions: [llm, semantic],
    smartFolders: FOLDERS
  });
  // The second folder is the confident one, so it is routed there.
  expect(decision.needsReview).toBe(false);
  expect(decision.candidate.folder).toBe('Beta');
});

test('a semantic match to the default folder is not a match', () => {
  const semantic = s(UNC, 0.9, 'semantic');
  const decision = decideRouting({
    file: file(),
    ranked: [semantic],
    sourceSuggestions: [semantic],
    smartFolders: FOLDERS
  });
  expect(decision.needsReview).toBe(true);
  expect(decision.reason).toBe('no_match');
});

test('a folder named after the file type is a name match, capped below auto-move', () => {
  const decision = decideRouting({
    file: file({ confidence: 95 }, 'report.pdf'),
    ranked: [],
    sourceSuggestions: [],
    smartFolders: [A, DOCS, UNC]
  });
  expect(decision.needsReview).toBe(false);
  expect(decision.basis).toBe('name_match');
  expect(decision.candidate.folder).toBe('Documents');
  expect(decision.candidate.confidence).toBe(NAME_ONLY_MAX_CONFIDENCE);
  expect(decision.nameMatch).toEqual({ kind: 'type', value: 'Documents' });
});

test('labels only name a folder when the routing mode ranks by them', () => {
  const named = file({ category: 'Alpha', vendor: 'Beta' });
  expect(findNameMatch(named, FOLDERS, { useLabels: false })).toBeNull();
  expect(findNameMatch(named, FOLDERS, { useLabels: true })).toMatchObject({
    kind: 'label',
    field: 'category'
  });
  // An embedding override replaced the label with the content's folder.
  const overridden = file({ category: 'Alpha', categorySource: 'embedding_override' });
  expect(findNameMatch(overridden, FOLDERS, { useLabels: true })).toBeNull();
});
