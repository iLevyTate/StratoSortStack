/**
 * Tests for the global organization-guidance helper.
 */

const mockLoad = jest.fn();

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => ({ load: mockLoad }))
}));

const {
  getOrganizationGuidance,
  formatOrganizationGuidanceBlock,
  MAX_GUIDANCE_CHARS
} = require('../src/main/analysis/organizationGuidance');

describe('formatOrganizationGuidanceBlock', () => {
  test('returns empty string for empty / whitespace / non-string input', () => {
    expect(formatOrganizationGuidanceBlock('')).toBe('');
    expect(formatOrganizationGuidanceBlock('   ')).toBe('');
    expect(formatOrganizationGuidanceBlock(/** @type {any} */ (null))).toBe('');
    expect(formatOrganizationGuidanceBlock(/** @type {any} */ (undefined))).toBe('');
  });

  test('wraps non-empty guidance into a labeled prompt block containing the text', () => {
    const block = formatOrganizationGuidanceBlock('Group invoices by vendor.');
    expect(block).toContain('USER ORGANIZATION INSTRUCTIONS');
    expect(block).toContain('Group invoices by vendor.');
    // Must not encourage inventing folders outside the provided list.
    expect(block.toLowerCase()).toContain('never invent');
  });
});

describe('getOrganizationGuidance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the trimmed guidance string from settings', async () => {
    mockLoad.mockResolvedValue({ organizationCustomGuidance: '  Keep tax docs together.  ' });
    await expect(getOrganizationGuidance()).resolves.toBe('Keep tax docs together.');
  });

  test('returns empty string when unset or non-string', async () => {
    mockLoad.mockResolvedValue({});
    await expect(getOrganizationGuidance()).resolves.toBe('');
    mockLoad.mockResolvedValue({ organizationCustomGuidance: 42 });
    await expect(getOrganizationGuidance()).resolves.toBe('');
  });

  test('caps guidance at MAX_GUIDANCE_CHARS', async () => {
    mockLoad.mockResolvedValue({
      organizationCustomGuidance: 'x'.repeat(MAX_GUIDANCE_CHARS + 500)
    });
    const result = await getOrganizationGuidance();
    expect(result.length).toBe(MAX_GUIDANCE_CHARS);
  });

  test('returns empty string when settings load throws', async () => {
    mockLoad.mockRejectedValue(new Error('disk error'));
    await expect(getOrganizationGuidance()).resolves.toBe('');
  });
});
