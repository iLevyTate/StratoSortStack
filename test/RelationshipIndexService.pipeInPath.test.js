/**
 * Edge keys used to be `${source}|${target}` and were split back on '|'. On
 * macOS and Linux a file name may contain '|', so such a path was cut in two
 * and the edge matched neither file: it vanished from getEdges and the Relate
 * view.
 */
jest.mock('electron', () => jest.requireActual('./mocks/electron'));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(async () => {
      const error = new Error('ENOENT');
      // @ts-ignore
      error.code = 'ENOENT';
      throw error;
    }),
    writeFile: jest.fn(async () => {}),
    rename: jest.fn(async () => {}),
    unlink: jest.fn(async () => {})
  }
}));

const RelationshipIndexService = require('../src/main/services/RelationshipIndexService');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');
const { normalizePathForIndex } = require('../src/shared/pathSanitization');

const idFor = (/** @type {string} */ p) => getSemanticFileId(normalizePathForIndex(p));

function makeService(/** @type {Record<string, string>} */ paths) {
  const entries = Object.fromEntries(
    Object.entries(paths).map(([id, originalPath]) => [
      id,
      { id, originalPath, analysis: { tags: ['finance', 'quarterly', 'report'] } }
    ])
  );
  return new RelationshipIndexService({
    analysisHistoryService: {
      initialize: jest.fn(),
      analysisHistory: { updatedAt: '2026-11-01T00:00:00.000Z', entries }
    }
  });
}

describe('RelationshipIndexService with "|" in a file path', () => {
  test.each([
    ['the piped path sorts second', '/files/Q1|Q2 report.pdf', '/files/A summary.pdf'],
    ['the piped path sorts first', '/files/A|B report.pdf', '/files/Z summary.pdf']
  ])('keeps both endpoints whole when %s', async (_label, pipedPath, otherPath) => {
    const service = makeService({ doc1: pipedPath, doc2: otherPath });
    const pipedId = idFor(pipedPath);
    const otherId = idFor(otherPath);

    const built = await service.buildIndex();
    expect(built.success).toBe(true);
    expect(built.edges).toHaveLength(1);
    const [edge] = built.edges;
    expect([edge.source, edge.target].sort()).toEqual([pipedId, otherId].sort());
    expect(edge.id).toBe(`rel:${edge.source}->${edge.target}`);

    const { edges } = await service.getEdges([pipedId, otherId]);
    expect(edges).toHaveLength(1);
  });
});
