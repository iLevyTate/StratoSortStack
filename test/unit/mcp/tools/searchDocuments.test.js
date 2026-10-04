'use strict';

describe('search_documents tool', () => {
  let captured;
  const fakeMcp = {
    registerTool: (_n, _s, h) => {
      captured = h;
    }
  };
  const services = {
    search: {
      hybridSearch: async () => ({
        results: [
          {
            fileName: 'a.pdf',
            filePath: 'C:\\docs\\a.pdf',
            analysis: { summary: 'Q4', category: 'Finance' },
            score: 0.87
          }
        ],
        total: 1,
        hasMore: false,
        fromCache: false
      })
    },
    analysisHistory: { getAll: () => ({}) },
    smartFolders: { list: async () => [] }
  };
  const {
    registerSearchDocuments
  } = require('../../../../src/main/transports/mcp/tools/searchDocuments');

  test('returns ranked results in MCP shape', async () => {
    registerSearchDocuments(fakeMcp, services);
    const out = await captured({ query: 'q4 earnings', top_k: 5, mode: 'hybrid' });
    const body = JSON.parse(out.content[0].text);
    expect(body.results[0]).toMatchObject({
      file_path: 'C:\\docs\\a.pdf',
      file_name: 'a.pdf',
      score: 0.87
    });
    expect(body.total_matches).toBe(1);
    expect(typeof body.query_ms).toBe('number');
  });

  test('maps the real SearchService hit shape (metadata / matchDetails)', async () => {
    const realShapeServices = {
      ...services,
      search: {
        hybridSearch: async () => ({
          results: [
            {
              id: 'doc-1',
              score: 0.61,
              metadata: {
                path: 'C:\\docs\\b.pdf',
                name: 'b.pdf',
                summary: 'Board minutes',
                extractedText: 'full text'
              },
              matchDetails: { bestSnippet: 'chunk text', contextSnippet: 'context text' }
            },
            {
              id: 'doc-2',
              score: 0.4,
              metadata: { path: 'C:\\docs\\c.pdf', name: 'c.pdf' },
              matchDetails: { bestSnippet: 'only a chunk snippet' }
            }
          ],
          total: 2
        })
      }
    };
    registerSearchDocuments(fakeMcp, realShapeServices);
    const out = await captured({ query: 'minutes' });
    const body = JSON.parse(out.content[0].text);
    expect(body.results).toEqual([
      expect.objectContaining({
        file_path: 'C:\\docs\\b.pdf',
        file_name: 'b.pdf',
        score: 0.61,
        snippet: 'Board minutes'
      }),
      expect.objectContaining({
        file_path: 'C:\\docs\\c.pdf',
        file_name: 'c.pdf',
        snippet: 'only a chunk snippet'
      })
    ]);
  });

  test('rejects empty query with INVALID_QUERY', async () => {
    registerSearchDocuments(fakeMcp, services);
    const out = await captured({ query: '' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('INVALID_QUERY');
  });
});

describe('search_documents folder-scope containment (symlink safety)', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const {
    registerSearchDocuments
  } = require('../../../../src/main/transports/mcp/tools/searchDocuments');

  const folderPath = path.resolve('/library/Docs');
  const insidePath = path.join(folderPath, 'report.pdf');
  const escapePath = path.join(folderPath, 'link.pdf'); // symlink whose realpath escapes the folder
  const escapeReal = path.resolve('/etc/passwd');
  const brokenPath = path.join(folderPath, 'gone.pdf'); // realpath throws (deleted/broken)

  let spy;
  let captured;

  const buildServices = () => ({
    search: {
      hybridSearch: async () => ({
        results: [
          { fileName: 'report.pdf', filePath: insidePath, analysis: { summary: 'in' }, score: 0.9 },
          { fileName: 'link.pdf', filePath: escapePath, analysis: { summary: 'esc' }, score: 0.8 },
          { fileName: 'gone.pdf', filePath: brokenPath, analysis: { summary: 'gone' }, score: 0.7 }
        ],
        total: 3
      })
    },
    analysisHistory: { getAll: () => ({}) },
    smartFolders: { list: async () => [{ id: 'sf1', name: 'Docs', path: folderPath }] }
  });

  const register = (services) => {
    const mcp = {
      registerTool: (_n, _s, h) => {
        captured = h;
      }
    };
    registerSearchDocuments(mcp, services);
  };

  beforeEach(() => {
    // Identity realpath for the folder and the in-folder file; escapePath
    // resolves OUTSIDE the folder (simulated symlink); anything else throws.
    // Mocking fs.realpathSync also drops its `.native` variant, so the tool's
    // `fs.realpathSync.native ? … : fs.realpathSync(p)` uses this mock.
    spy = jest.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      if (p === folderPath) return folderPath;
      if (p === insidePath) return insidePath;
      if (p === escapePath) return escapeReal;
      const e = new Error(`ENOENT: ${p}`);
      e.code = 'ENOENT';
      throw e;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  test('keeps in-folder hits and drops symlink-escaping / unresolvable ones', async () => {
    register(buildServices());
    const out = await captured({ query: 'q', smart_folder_id: 'sf1' });
    const body = JSON.parse(out.content[0].text);
    expect(body.results.map((r) => r.file_path)).toEqual([insidePath]);
    expect(body.total_matches).toBe(1);
  });

  test('fails closed to empty when the folder path itself cannot be resolved', async () => {
    spy.mockImplementation((p) => {
      if (p === folderPath) {
        const e = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      }
      return p;
    });
    register(buildServices());
    const out = await captured({ query: 'q', smart_folder_id: 'sf1' });
    const body = JSON.parse(out.content[0].text);
    expect(body.results).toEqual([]);
    expect(body.total_matches).toBe(0);
  });
});
