'use strict';

describe('get_document_summary tool', () => {
  let captured;
  const fakeMcp = {
    registerTool: (_n, _s, h) => {
      captured = h;
    }
  };
  const entry = {
    originalPath: 'C:\\docs\\a.pdf',
    fileName: 'a.pdf',
    timestamp: '2024-01-01T00:00:00.000Z',
    analysis: {
      category: 'Finance',
      entity: 'Acme',
      documentType: 'report',
      documentDate: '2023-12-31',
      summary: 'Quarterly earnings',
      tags: ['Q4'],
      keyEntities: ['Acme Corp'],
      confidence: 90,
      subject: 'Q4 Report'
    },
    organization: { newName: 'acme-q4-earnings.pdf' }
  };
  const services = {
    analysisHistory: {
      getAnalysisByPath: async (p) => (p === 'C:\\docs\\a.pdf' ? entry : null)
    }
  };
  const {
    registerGetDocumentSummary
  } = require('../../../../src/main/transports/mcp/tools/getDocumentSummary');

  test('returns summary for analyzed file', async () => {
    registerGetDocumentSummary(fakeMcp, services);
    const result = await captured({ file_path: 'C:\\docs\\a.pdf' });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      file_path: 'C:\\docs\\a.pdf',
      summary: 'Quarterly earnings',
      category: 'Finance',
      entity: 'Acme',
      type: 'report',
      date: '2023-12-31',
      keywords: ['Q4'],
      key_entities: ['Acme Corp'],
      suggested_name: 'acme-q4-earnings.pdf',
      confidence: 90,
      analyzed_at: '2024-01-01T00:00:00.000Z'
    });
  });

  test('returns FILE_NOT_ANALYZED when no history hit', async () => {
    registerGetDocumentSummary(fakeMcp, services);
    const result = await captured({ file_path: 'C:\\docs\\missing.pdf' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FILE_NOT_ANALYZED');
  });

  test('rejects relative path with INVALID_PATH', async () => {
    registerGetDocumentSummary(fakeMcp, services);
    const result = await captured({ file_path: 'relative/path.pdf' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PATH');
  });

  test('normalizes traversal segments before lookup', async () => {
    const seen = [];
    registerGetDocumentSummary(fakeMcp, {
      analysisHistory: {
        getAnalysisByPath: async (p) => {
          seen.push(p);
          return null;
        }
      }
    });
    const result = await captured({ file_path: 'C:\\other\\..\\docs\\a.pdf' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FILE_NOT_ANALYZED');
    expect(seen).toEqual(['C:\\docs\\a.pdf']);
  });

  test('rejects NTFS alternate data stream syntax with INVALID_PATH', async () => {
    registerGetDocumentSummary(fakeMcp, services);
    const result = await captured({ file_path: 'C:\\docs\\a.pdf:hidden' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PATH');
  });

  test('rejects UNC path with INVALID_PATH', async () => {
    registerGetDocumentSummary(fakeMcp, services);
    const result = await captured({ file_path: '\\\\server\\share\\a.pdf' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PATH');
  });

  test('returns SERVICE_UNAVAILABLE when analysisHistory is unavailable', async () => {
    registerGetDocumentSummary(fakeMcp, { analysisHistory: null });
    const result = await captured({ file_path: 'C:\\docs\\a.pdf' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SERVICE_UNAVAILABLE');
  });
});

describe('get_document_summary file_path after organize', () => {
  test('returns where the file is now, not where it was analyzed', async () => {
    let handler;
    const {
      registerGetDocumentSummary
    } = require('../../../../src/main/transports/mcp/tools/getDocumentSummary');
    registerGetDocumentSummary(
      { registerTool: (_n, _s, h) => (handler = h) },
      {
        analysisHistory: {
          getAnalysisByPath: async () => ({
            originalPath: 'C:\\Downloads\\scan.pdf',
            analysis: { summary: 'Lease', category: 'Legal' },
            organization: { actual: 'C:\\Sorted\\Legal\\lease-2026.pdf', newName: 'lease-2026.pdf' }
          })
        }
      }
    );
    const result = await handler({ file_path: 'C:\\Sorted\\Legal\\lease-2026.pdf' });
    expect(JSON.parse(result.content[0].text).file_path).toBe('C:\\Sorted\\Legal\\lease-2026.pdf');
  });
});
