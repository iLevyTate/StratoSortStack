/**
 * @jest-environment node
 *
 * Regression guard for the purpose-fragment fallback in
 * `_buildLlmCategorySuggestion` (OrganizationSuggestionServiceCore.js).
 *
 * Why this test exists
 * --------------------
 * Pre-fix the function consulted only short label-like fields:
 *   smartFolder | folder | category | type
 * If the LLM emitted a generic category ("document", "image", "file") and
 * a meaningful sentence in `purpose` ("Q3 sales pipeline review"), the
 * label-only path returned `null` and the file routed to "Uncategorized"
 * despite carrying a clear signal — confirmed v3 regression vs v2.0.9.
 *
 * Behavioral contract guarded here:
 *   1. Specific (non-generic) category -> `matchCategoryToFolder` is
 *      invoked with the category verbatim; `purpose` is ignored.
 *   2. Generic category ("document", "image", etc.) + meaningful purpose
 *      -> first short fragment of purpose (clause-bounded, ≤ 6 words) is
 *      forwarded to `matchCategoryToFolder`. A full sentence with token
 *      overlap MUST NOT reach the matcher (it would latch onto unrelated
 *      folders).
 *   3. Empty/missing label fields + purpose -> same fragment fallback.
 *   4. No purpose at all + generic category -> returns `null` (signal
 *      neither label nor purpose can recover).
 *
 * We spy on `FolderMatchingService.matchCategoryToFolder` to assert on
 * the exact `rawCategory` flowing through, since that's the production
 * contract we care about — not the matcher's downstream scoring.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

const FolderMatchingService = require('../src/main/services/FolderMatchingService');
const {
  OrganizationSuggestionServiceCore
} = require('../src/main/services/organization/OrganizationSuggestionServiceCore');

function makeService() {
  // Minimum dependency stubs — _buildLlmCategorySuggestion only consults
  // FolderMatchingService.matchCategoryToFolder and the smartFolders
  // array; the constructor's vectorDb/settings are not exercised.
  return new OrganizationSuggestionServiceCore({
    vectorDbService: {
      initialize: jest.fn(),
      isServerAvailable: jest.fn().mockResolvedValue(false),
      getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 0 })
    },
    folderMatchingService: {
      matchFileToFolders: jest.fn().mockResolvedValue([]),
      embedText: jest.fn().mockResolvedValue({ vector: new Array(8).fill(0) })
    },
    settingsService: {
      get: jest.fn(),
      load: jest.fn().mockResolvedValue({}),
      save: jest.fn().mockResolvedValue({ success: true })
    }
  });
}

const SMART_FOLDERS = [
  {
    id: 'sales',
    name: 'Sales Pipeline',
    path: '/docs/Sales Pipeline',
    description: 'Quarterly sales pipeline reviews and forecasts'
  },
  {
    id: 'reports',
    name: 'Reports',
    path: '/docs/Reports',
    description: 'Reports and summaries'
  }
];

describe('_buildLlmCategorySuggestion — purpose fragment fallback for generic categories', () => {
  let service;
  let matchSpy;

  beforeEach(() => {
    service = makeService();
    matchSpy = jest
      .spyOn(FolderMatchingService, 'matchCategoryToFolder')
      .mockReturnValue('Sales Pipeline');
  });

  afterEach(() => {
    matchSpy.mockRestore();
  });

  test('non-generic category is forwarded verbatim; purpose is ignored', () => {
    const file = {
      analysis: {
        category: 'Sales Pipeline',
        purpose: 'Q3 sales pipeline review with forecast adjustments',
        confidence: 0.9
      }
    };

    const result = service._buildLlmCategorySuggestion(file, SMART_FOLDERS);

    expect(matchSpy).toHaveBeenCalledTimes(1);
    expect(matchSpy).toHaveBeenCalledWith('Sales Pipeline', SMART_FOLDERS);
    expect(result?.folder).toBe('Sales Pipeline');
  });

  test('generic category + meaningful purpose forwards a short purpose fragment to the matcher', () => {
    const file = {
      analysis: {
        category: 'document', // generic — triggers fallback
        purpose: 'Q3 sales pipeline review with forecast adjustments. Includes regional cuts.',
        confidence: 0.8
      }
    };

    const result = service._buildLlmCategorySuggestion(file, SMART_FOLDERS);

    // The fragment cap is "first clause + first 6 words". Verify exactly
    // that — not the entire sentence (which would let token overlap latch
    // onto unrelated folders).
    expect(matchSpy).toHaveBeenCalledTimes(1);
    const [forwarded] = matchSpy.mock.calls[0];
    expect(forwarded).toBe('Q3 sales pipeline review with forecast');
    expect(forwarded.split(/\s+/).length).toBeLessThanOrEqual(6);
    expect(forwarded).not.toContain('Includes regional');
    expect(result?.folder).toBe('Sales Pipeline');
  });

  test('every generic-category alias triggers the fallback', () => {
    // Lock down the canonical generic set so silent additions/removals to
    // GENERIC_CATEGORIES surface in tests rather than as a regression.
    const generics = [
      'document',
      'documents',
      'image',
      'images',
      'file',
      'files',
      'media',
      'misc',
      'miscellaneous',
      'other',
      'uncategorized'
    ];

    for (const generic of generics) {
      matchSpy.mockClear();
      service._buildLlmCategorySuggestion(
        {
          analysis: {
            category: generic,
            purpose: 'monthly invoice batch'
          }
        },
        SMART_FOLDERS
      );
      // Each generic category must yield the purpose fragment, not the
      // generic category itself.
      const [forwarded] = matchSpy.mock.calls[0];
      expect(forwarded).toBe('monthly invoice batch');
    }
  });

  test('case-insensitive generic detection ("DOCUMENT" / "  Image  ")', () => {
    matchSpy.mockClear();
    service._buildLlmCategorySuggestion(
      {
        analysis: {
          category: '  DOCUMENT  ',
          purpose: 'expense report Q4'
        }
      },
      SMART_FOLDERS
    );
    expect(matchSpy.mock.calls[0][0]).toBe('expense report Q4');
  });

  test('empty/missing label fields + purpose still falls back to fragment', () => {
    const file = {
      analysis: {
        category: '',
        type: '',
        purpose: 'travel reimbursement form for May'
      }
    };

    service._buildLlmCategorySuggestion(file, SMART_FOLDERS);
    expect(matchSpy.mock.calls[0][0]).toBe('travel reimbursement form for May');
  });

  test('clause break short-circuits the fragment before the word cap', () => {
    // The split-on-clause-break runs first, so a 3-word clause stays
    // 3 words even though the slice limit is 6.
    service._buildLlmCategorySuggestion(
      {
        analysis: {
          category: 'document',
          purpose: 'invoice batch, with attached receipts and tax computations.'
        }
      },
      SMART_FOLDERS
    );
    expect(matchSpy.mock.calls[0][0]).toBe('invoice batch');
  });

  test('whitespace-only purpose does not trigger the fragment branch (matcher sees the generic category)', () => {
    // Whitespace `purpose.trim()` is falsy, so the fallback condition
    // declines and the production code falls through to matching against
    // the (generic) category as-is. We assert on WHAT was forwarded —
    // the regression we are guarding is "purpose fragment fed into matcher
    // when it shouldn't be", not the matcher's own fallback behavior.
    service._buildLlmCategorySuggestion(
      {
        analysis: {
          category: 'document',
          purpose: '            '
        }
      },
      SMART_FOLDERS
    );
    expect(matchSpy).toHaveBeenCalledTimes(1);
    expect(matchSpy.mock.calls[0][0]).toBe('document');
  });

  test('non-string purpose is ignored; matcher receives the generic category, not the bad purpose value', () => {
    service._buildLlmCategorySuggestion(
      {
        analysis: {
          category: 'document',
          purpose: 12345 // wrong type — must NOT be coerced and forwarded
        }
      },
      SMART_FOLDERS
    );
    expect(matchSpy).toHaveBeenCalledTimes(1);
    expect(matchSpy.mock.calls[0][0]).toBe('document');
  });

  test('returns null when label and purpose are both empty/missing (no signal at all)', () => {
    // No category, no type, no folder, no smartFolder, no purpose ->
    // rawCategory stays falsy and the early-return guard fires.
    const result = service._buildLlmCategorySuggestion(
      {
        analysis: {}
      },
      SMART_FOLDERS
    );

    expect(matchSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

// CP-25 follow-up: the 0.95 lift trusts "the LLM explicitly categorized it".
// A fallback analysis's category is a filename/extension guess, and lifting
// it to 0.95 cleared the 0.75 auto-organize threshold on no content at all.
describe('_buildLlmCategorySuggestion: no high-confidence lift for fallback analyses', () => {
  let service;
  let matchSpy;

  beforeEach(() => {
    service = makeService();
    matchSpy = jest
      .spyOn(FolderMatchingService, 'matchCategoryToFolder')
      .mockReturnValue('Reports');
  });

  afterEach(() => {
    matchSpy.mockRestore();
  });

  test('a real LLM category that matches a folder is lifted to 0.95', () => {
    const result = service._buildLlmCategorySuggestion(
      { analysis: { category: 'Reports', confidence: 60, extractionMethod: 'pdf-text' } },
      SMART_FOLDERS
    );
    expect(result.score).toBeCloseTo(0.95, 5);
  });

  test('a filename-only fallback keeps its own confidence', () => {
    const result = service._buildLlmCategorySuggestion(
      { analysis: { category: 'Reports', confidence: 60, extractionMethod: 'filename' } },
      SMART_FOLDERS
    );
    expect(result.folder).toBe('Reports');
    expect(result.score).toBeCloseTo(0.6, 5);
  });
});
