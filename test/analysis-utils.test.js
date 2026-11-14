/**
 * Tests for Analysis Utils
 * Tests result normalization utilities
 */

describe('Analysis Utils', () => {
  let normalizeAnalysisResult;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    const module = require('../src/main/analysis/utils');
    normalizeAnalysisResult = module.normalizeAnalysisResult;
  });

  describe('normalizeAnalysisResult', () => {
    test('normalizes valid result', () => {
      const raw = {
        category: 'Reports',
        keywords: ['report', 'quarterly'],
        confidence: 0.95,
        suggestedName: 'Q4_Report.pdf',
        extractionMethod: 'text',
        contentLength: 5000
      };

      const result = normalizeAnalysisResult(raw);

      expect(result.category).toBe('Reports');
      expect(result.keywords).toEqual(['report', 'quarterly']);
      expect(result.confidence).toBe(0.95);
      expect(result.suggestedName).toBe('Q4_Report.pdf');
      expect(result.extractionMethod).toBe('text');
      expect(result.contentLength).toBe(5000);
    });

    test('uses fallback for missing category', () => {
      const raw = { confidence: 0.8 };
      const fallback = { category: 'Documents' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.category).toBe('Documents');
    });

    test('uses default category when no fallback', () => {
      const raw = { confidence: 0.8 };

      const result = normalizeAnalysisResult(raw);

      expect(result.category).toBe('document');
    });

    test('uses fallback for empty string category', () => {
      const raw = { category: '' };
      const fallback = { category: 'Fallback' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.category).toBe('Fallback');
    });

    test('uses fallback for whitespace-only category', () => {
      const raw = { category: '   ' };
      const fallback = { category: 'Fallback' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.category).toBe('Fallback');
    });

    test('uses fallback for non-string category', () => {
      const raw = { category: 123 };
      const fallback = { category: 'Fallback' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.category).toBe('Fallback');
    });

    test('uses fallback for non-array keywords', () => {
      const raw = { keywords: 'not-an-array' };
      const fallback = { keywords: ['fallback', 'keyword'] };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.keywords).toEqual(['fallback', 'keyword']);
    });

    test('uses empty array when no keywords fallback', () => {
      const raw = { keywords: 'not-an-array' };

      const result = normalizeAnalysisResult(raw);

      expect(result.keywords).toEqual([]);
    });

    test('coerces categorical confidence tokens rather than falling back', () => {
      // Models routinely return "high"/"medium"/"low" instead of a number; the
      // image-analysis path used to hand-parse these while the document path
      // collapsed to the fallback. normalizeAnalysisResult now maps the
      // token to the same 0-1 scale both paths expect, so a caller-supplied
      // numeric fallback is only used when coercion genuinely fails.
      const raw = { confidence: 'high' };
      const fallback = { confidence: 0.5 };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.confidence).toBe(0.9);
    });

    test('falls back to fallback when string confidence is not coerceable', () => {
      const raw = { confidence: 'not-a-real-value' };
      const fallback = { confidence: 0.5 };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.confidence).toBe(0.5);
    });

    test('uses 0 when no confidence fallback', () => {
      const raw = { confidence: 'invalid' };

      const result = normalizeAnalysisResult(raw);

      expect(result.confidence).toBe(0);
    });

    test('uses fallback for non-string suggestedName', () => {
      const raw = { suggestedName: 123 };
      const fallback = { suggestedName: 'fallback.pdf' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.suggestedName).toBe('fallback.pdf');
    });

    test('uses null when no suggestedName fallback', () => {
      const raw = { suggestedName: 123 };

      const result = normalizeAnalysisResult(raw);

      expect(result.suggestedName).toBeNull();
    });

    test('preserves extractionMethod from raw', () => {
      const raw = { extractionMethod: 'ocr' };

      const result = normalizeAnalysisResult(raw);

      expect(result.extractionMethod).toBe('ocr');
    });

    test('uses fallback for missing extractionMethod', () => {
      const raw = {};
      const fallback = { extractionMethod: 'text' };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.extractionMethod).toBe('text');
    });

    test('uses fallback for non-number contentLength', () => {
      const raw = { contentLength: 'large' };
      const fallback = { contentLength: 1000 };

      const result = normalizeAnalysisResult(raw, fallback);

      expect(result.contentLength).toBe(1000);
    });

    test('handles null raw input', () => {
      const result = normalizeAnalysisResult(null);

      expect(result.category).toBe('document');
      expect(result.keywords).toEqual([]);
      expect(result.confidence).toBe(0);
    });

    test('handles undefined raw input', () => {
      const result = normalizeAnalysisResult(undefined);

      expect(result.category).toBe('document');
      expect(result.confidence).toBe(0);
    });

    test('preserves extra properties from raw', () => {
      const raw = {
        category: 'Reports',
        customProperty: 'custom-value',
        anotherProp: 123
      };

      const result = normalizeAnalysisResult(raw);

      expect(result.customProperty).toBe('custom-value');
      expect(result.anotherProp).toBe(123);
    });

    test('normalized values override raw values', () => {
      const raw = {
        category: 'ValidCategory',
        keywords: ['valid']
      };

      const result = normalizeAnalysisResult(raw);

      // Normalized category should override raw
      expect(result.category).toBe('ValidCategory');
      expect(result.keywords).toEqual(['valid']);
    });
  });
});

// Small models sometimes answer with the prompt instead of the file: a schema
// instruction or a smart folder's description, copied word for word. The
// examples below are values found in a real analysis history.
describe('dropPromptEchoes', () => {
  const { dropPromptEchoes } = require('../src/main/analysis/utils');
  const folders = [
    {
      name: 'Logos',
      description: 'Art, graphic design, images not related to other categories, logos.'
    },
    {
      name: 'Research',
      description:
        'Anything to do with topics like SCAN, SCANUE, STAC, SCANAQ code related to neuromorphic or agent systems and code related to that topic.'
    }
  ];

  test.each([
    [
      'a folder description',
      'purpose',
      'Art, graphic design, images not related to other categories, logos'
    ],
    [
      'a paraphrased description',
      'summary',
      'Research on SCANUE, a code related to neuromorphic or agent systems.'
    ],
    [
      'the summary instruction',
      'summary',
      "A concise 1-2 sentence summary of the document's content."
    ],
    ['a shortened instruction', 'summary', "A concise summary of the document's content."],
    [
      'the naming instruction, examples and all',
      'summary',
      "A short, concise topic-based filename (max 3 words) using underscores (e.g., 'budget_report', 'sunset_beach'). Do NOT include the extension."
    ]
  ])('clears %s and caps the confidence', (_label, field, value) => {
    const result = dropPromptEchoes({ category: 'Logos', confidence: 90, [field]: value }, folders);
    expect(result[field]).toBeNull();
    expect(result.confidence).toBe(50);
    expect(result.promptEchoFields).toEqual([field]);
  });

  test.each([
    'A colorful image of a sunset beach landscape.',
    'A logo for a company or organization.',
    'A study on neuromorphic agent systems.',
    'The study examines the detection of simulator authenticity using a tabula rasa recurrent network.'
  ])('keeps a real answer that only shares words: %s', (summary) => {
    const input = { category: 'Research', confidence: 90, summary };
    expect(dropPromptEchoes(input, folders)).toBe(input);
  });

  test('caps on the 0-1 scale when the confidence is on it', () => {
    const result = dropPromptEchoes(
      { confidence: 0.9, summary: "A concise 1-2 sentence summary of the document's content." },
      folders
    );
    expect(result.confidence).toBe(0.5);
  });

  test('passes a missing answer through', () => {
    expect(dropPromptEchoes(null, folders)).toBeNull();
  });

  // Folders whose descriptions name the columns their files carry: a correct
  // answer reads the same words out of the file.
  describe('with well-described folders', () => {
    const exportFolders = [
      {
        name: 'GSC exports',
        description:
          'Google Search Console performance exports in Excel: queries, pages, clicks, impressions, CTR and position.'
      },
      {
        name: 'Bing exports',
        description:
          'Bing Webmaster Tools exports: keywords, pages, clicks and impressions from Bing search.'
      },
      {
        name: 'Clarity exports',
        description:
          'Microsoft Clarity CSV exports: sessions, users, scroll depth, browsers and devices.'
      },
      {
        name: 'SEO audits',
        description: 'PDF SEO audit reports with site scores, backlinks and recommendations.'
      }
    ];
    const bingDocument =
      'bing-webmaster-tools-keywords.csv\nBing Webmaster Tools - Search Performance\nKeyword,Clicks,Impressions,CTR,Avg position\nlocal ai organizer,12,340,3.5%,4.2';
    const clarityDocument =
      'clarity-dashboard-export.csv\nMicrosoft Clarity dashboard\nSessions,Users,Scroll depth,Browsers\n1520,1203,54%,Chrome';
    const gscDocument =
      'Queries.xlsx\nTop queries,Clicks,Impressions,CTR,Position\nfile organizer,40,1200,3.3%,6.1';

    test.each([
      [
        'reasoning that cites the folder description',
        'reasoning',
        'Contains Bing Webmaster Tools keywords, clicks and impressions from Bing search.',
        bingDocument
      ],
      [
        'a summary in the folder description words',
        'summary',
        'Bing Webmaster Tools export of keywords, pages, clicks and impressions.',
        bingDocument
      ],
      [
        'a summary naming the file columns',
        'summary',
        'Microsoft Clarity CSV export: sessions, users, scroll depth and browsers.',
        clarityDocument
      ],
      [
        'a terse dashboard summary',
        'summary',
        'Microsoft Clarity dashboard export: sessions, users, scroll depth and browsers.',
        clarityDocument
      ],
      [
        'a purpose naming the file columns',
        'purpose',
        'Search Console export of queries, clicks, impressions, CTR and position.',
        gscDocument
      ]
    ])('keeps %s', (_label, field, value, documentText) => {
      const input = { category: 'Bing exports', confidence: 90, [field]: value };
      expect(dropPromptEchoes(input, exportFolders, documentText)).toBe(input);
    });

    test('keeps reasoning that cites a folder description without document text', () => {
      const input = {
        category: 'Bing exports',
        confidence: 90,
        reasoning:
          'Contains Bing Webmaster Tools keywords, clicks and impressions from Bing search.'
      };
      expect(dropPromptEchoes(input, exportFolders)).toBe(input);
    });

    test('still clears a description copied with no support in the document', () => {
      const result = dropPromptEchoes(
        {
          category: 'SEO audits',
          confidence: 90,
          summary: 'PDF SEO audit reports with site scores, backlinks and recommendations.'
        },
        exportFolders,
        'vacation-photos.txt\nPacking list for the beach trip: towels, sunscreen, snacks.'
      );
      expect(result.summary).toBeNull();
      expect(result.confidence).toBe(50);
      expect(result.promptEchoFields).toEqual(['summary']);
    });

    test('still clears a copied description when no document text is given', () => {
      const result = dropPromptEchoes(
        {
          confidence: 90,
          summary: 'Bing Webmaster Tools export of keywords, pages, clicks and impressions.'
        },
        exportFolders
      );
      expect(result.summary).toBeNull();
      expect(result.confidence).toBe(50);
    });

    test('still clears a copied schema instruction in the reasoning', () => {
      const result = dropPromptEchoes(
        {
          confidence: 90,
          reasoning:
            'Brief explanation of why this category was chosen based on the content and folder description.'
        },
        exportFolders,
        bingDocument
      );
      expect(result.reasoning).toBeNull();
      expect(result.promptEchoFields).toEqual(['reasoning']);
    });

    test('does not let common document words hide a copied schema instruction', () => {
      const result = dropPromptEchoes(
        { confidence: 90, summary: "A concise 1-2 sentence summary of the document's content." },
        exportFolders,
        'Write a concise summary of the document content in 1 or 2 sentences.'
      );
      expect(result.summary).toBeNull();
    });
  });
});
