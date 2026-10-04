/**
 * Static contract for F-191 (CP-11 / CP-14): every production call to
 * `buildEmbeddingSummary` threads the embedding-model budget options, so no
 * ingestion route silently embeds against the 512-token floor. Routes that
 * embed different amounts of the same document produce vectors whose cosine
 * scores are not comparable, so this is a search-quality invariant, not style.
 */
'use strict';
const fs = jest.requireActual('fs');
const path = require('path');

const ROUTES = [
  'src/main/analysis/semanticFolderMatcher.js',
  'src/main/services/SmartFolderWatcher.js',
  'src/main/ipc/files/embeddingSync.js',
  // Rebuild-files / onlyMissing backfill (CP-14, D5): must rebuild the same
  // text the live routes embed, or a rebuilt index is a different index.
  'src/main/ipc/semantic.js',
  // Downloads auto-organize (CP-14): used an ad-hoc join until 2026-09-29.
  'src/main/services/DownloadWatcher.js'
];

function callSites(source) {
  const sites = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('buildEmbeddingSummary(', from);
    if (start < 0) break;
    // Slice to the statement terminator; every call site ends its statement
    // with `);` before the next line that starts a new declaration.
    const end = source.indexOf(');', start);
    sites.push(source.slice(start, end < 0 ? undefined : end + 2));
    from = start + 1;
  }
  return sites;
}

describe('embedding budget is threaded on every ingestion route', () => {
  test.each(ROUTES)('%s', (rel) => {
    const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const sites = callSites(source);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toMatch(/embeddingModel|resolveEmbeddingModelOptions/);
    }
  });

  test('no other production file calls buildEmbeddingSummary without going through the routes above', () => {
    const walk = (dir, acc = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (entry.name.endsWith('.js')) acc.push(full);
      }
      return acc;
    };
    const root = path.join(__dirname, '..', 'src', 'main');
    const callers = walk(root)
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return (
          text.includes('buildEmbeddingSummary(') &&
          !text.includes('function buildEmbeddingSummary')
        );
      })
      .map((file) => path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual([...ROUTES].sort());
  });
});
