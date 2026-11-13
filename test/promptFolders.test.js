/**
 * @jest-environment node
 *
 * selectPromptFolders decides which Smart Folders the analysis prompt lists.
 * Hans added his own folders after the 8 defaults; a plain slice(0, 10) left
 * them out of the prompt, so the AI never saw them.
 */

const { selectPromptFolders } = require('../src/shared/promptFolders');
const { TRUNCATION } = require('../src/shared/performanceConstants');

const DEFAULT_NAMES = [
  'Uncategorized',
  'Documents',
  'Images',
  'Videos',
  'Music',
  'Spreadsheets',
  'Presentations',
  'Archives'
];

function defaults() {
  return DEFAULT_NAMES.map((name) => ({ name, description: `${name} default`, isDefault: true }));
}

function custom(n, prefix = 'Custom') {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    description: `${prefix} folder ${i + 1}`,
    isDefault: false
  }));
}

describe('selectPromptFolders', () => {
  test('prompt limits are separate from the UI display limit', () => {
    expect(TRUNCATION.PROMPT_FOLDERS_MAX).toBe(20);
    expect(TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MAX).toBe(300);
    expect(TRUNCATION.FOLDERS_DISPLAY).toBe(10);
  });

  test('keeps every folder when under the limit, catch-all last, stored order otherwise', () => {
    const folders = [...defaults(), ...custom(5)];
    const { folders: picked, omitted } = selectPromptFolders(folders);
    expect(omitted).toBe(0);
    expect(picked).toHaveLength(13);
    expect(picked[picked.length - 1].name).toBe('Uncategorized');
    expect(picked.map((f) => f.name)).toEqual([
      ...DEFAULT_NAMES.slice(1),
      ...custom(5).map((f) => f.name),
      'Uncategorized'
    ]);
  });

  test('with more folders than the limit, user folders win over defaults and the catch-all stays', () => {
    const folders = [...defaults(), ...custom(17)];
    const { folders: picked, omitted } = selectPromptFolders(folders);
    expect(picked).toHaveLength(TRUNCATION.PROMPT_FOLDERS_MAX);
    expect(omitted).toBe(25 - TRUNCATION.PROMPT_FOLDERS_MAX);
    const names = picked.map((f) => f.name);
    for (const f of custom(17)) expect(names).toContain(f.name);
    expect(names[names.length - 1]).toBe('Uncategorized');
  });

  test('with only custom folders past the limit, the last ones are left out', () => {
    const { folders: picked, omitted } = selectPromptFolders(custom(25));
    expect(picked).toHaveLength(20);
    expect(omitted).toBe(5);
    expect(picked[0].name).toBe('Custom 1');
    expect(picked[19].name).toBe('Custom 20');
  });

  test('cuts long descriptions and names, and skips nameless entries', () => {
    const { folders: picked, omitted } = selectPromptFolders([
      { name: '   ', description: 'blank' },
      null,
      { description: 'no name' },
      { name: `  ${'N'.repeat(80)}  `, description: `  ${'d'.repeat(900)}  ` }
    ]);
    expect(omitted).toBe(0);
    expect(picked).toHaveLength(1);
    expect(picked[0].name).toBe('N'.repeat(TRUNCATION.NAME_MAX));
    expect(picked[0].description).toHaveLength(TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MAX);
  });

  test('honours max and descriptionMax overrides', () => {
    const { folders: picked, omitted } = selectPromptFolders(custom(4), {
      max: 2,
      descriptionMax: 3
    });
    expect(picked.map((f) => f.name)).toEqual(['Custom 1', 'Custom 2']);
    expect(picked[0].description).toBe('Cus');
    expect(omitted).toBe(2);
  });

  test('handles non-array input', () => {
    expect(selectPromptFolders(undefined)).toEqual({ folders: [], omitted: 0 });
  });

  test('a user folder given the category "uncategorized" is listed, not dropped as a second catch-all', () => {
    const folders = [
      { name: 'Uncategorized', category: 'uncategorized', isDefault: true, description: 'x' },
      { name: 'Other', category: 'uncategorized', isDefault: false, description: 'Anything else' },
      { name: 'Test Folder', category: 'uncategorized', description: 'Testing' }
    ];
    const { folders: picked, omitted } = selectPromptFolders(folders);
    expect(omitted).toBe(0);
    expect(picked.map((f) => f.name)).toEqual(['Other', 'Test Folder', 'Uncategorized']);
  });

  test('a user folder listed first with that category does not replace the real catch-all', () => {
    const folders = [
      { name: 'Other', category: 'uncategorized', isDefault: false, description: 'Anything else' },
      { name: 'Uncategorized', category: 'uncategorized', isDefault: true, description: 'x' }
    ];
    const { folders: picked } = selectPromptFolders(folders);
    expect(picked.map((f) => f.name)).toEqual(['Other', 'Uncategorized']);
  });

  test('a renamed seeded catch-all is still the catch-all', () => {
    const folders = [
      { name: 'Strato test Data', category: 'uncategorized', isDefault: true, description: 'x' },
      ...custom(2)
    ];
    const { folders: picked } = selectPromptFolders(folders);
    expect(picked[picked.length - 1].name).toBe('Strato test Data');
  });
});

describe('selectPromptFolders with a context size', () => {
  const CHARS_PER_TOKEN = 3;
  /** Characters the list takes in the prompt: one numbered line per folder. */
  function listChars(picked) {
    return picked
      .map((f, i) => `${i + 1}. "${f.name}" — ${f.description || 'no description provided'}`)
      .join('\n').length;
  }
  function longFolders(n, descLen = 250) {
    return Array.from({ length: n }, (_, i) => ({
      name: `Project folder ${i + 1}`,
      description: `${'Long description words '.repeat(20)}`.slice(0, descLen),
      isDefault: false
    }));
  }

  test('2048-token context: 15 folders with long descriptions stay a bounded share of the context', () => {
    const contextTokens = 2048;
    const folders = [
      ...longFolders(15),
      { name: 'Uncategorized', category: 'uncategorized', isDefault: true, description: 'd' }
    ];
    const { folders: picked, omitted } = selectPromptFolders(folders, { contextTokens });

    // The old cap of 10 folders, catch-all included and last.
    expect(picked).toHaveLength(TRUNCATION.PROMPT_FOLDERS_COMPACT_MAX);
    expect(picked[picked.length - 1].name).toBe('Uncategorized');
    expect(omitted).toBe(folders.length - picked.length);
    // Every listed folder keeps its full name.
    for (const f of picked.slice(0, -1)) expect(f.name).toMatch(/^Project folder \d+$/);
    // The list fits its share of the context.
    const budgetChars = Math.floor(
      contextTokens * TRUNCATION.PROMPT_FOLDER_CONTEXT_SHARE * CHARS_PER_TOKEN
    );
    expect(listChars(picked)).toBeLessThanOrEqual(budgetChars);
    expect(listChars(picked) / CHARS_PER_TOKEN).toBeLessThan(contextTokens * 0.3);
    // Descriptions are shortened, not removed.
    for (const f of picked.slice(0, -1)) {
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.description.length).toBeLessThan(250);
    }
  });

  test('2048-token context: a handful of folders keeps every one and trims only long descriptions', () => {
    const folders = [
      ...longFolders(4, 600),
      { name: 'Receipts', description: 'Store receipts', isDefault: false },
      { name: 'Uncategorized', category: 'uncategorized', isDefault: true, description: 'd' }
    ];
    const { folders: picked, omitted } = selectPromptFolders(folders, { contextTokens: 2048 });
    expect(omitted).toBe(0);
    expect(picked).toHaveLength(6);
    expect(picked.find((f) => f.name === 'Receipts').description).toBe('Store receipts');
    expect(listChars(picked)).toBeLessThanOrEqual(
      Math.floor(2048 * TRUNCATION.PROMPT_FOLDER_CONTEXT_SHARE * CHARS_PER_TOKEN)
    );
  });

  test('a large context keeps 20 folders with full 300-character descriptions', () => {
    const { folders: picked, omitted } = selectPromptFolders(longFolders(20, 300), {
      contextTokens: 32768
    });
    expect(omitted).toBe(0);
    expect(picked).toHaveLength(20);
    for (const f of picked) expect(f.description).toHaveLength(300);
  });

  test('a 4096-token context keeps 20 short-described folders', () => {
    const { folders: picked } = selectPromptFolders(longFolders(20, 60), {
      contextTokens: 4096
    });
    expect(picked).toHaveLength(20);
    for (const f of picked) expect(f.description).toHaveLength(60);
  });

  test('without a context size the fixed limits apply', () => {
    const { folders: picked } = selectPromptFolders(longFolders(15, 300));
    expect(picked).toHaveLength(15);
    for (const f of picked) expect(f.description).toHaveLength(300);
  });
});
