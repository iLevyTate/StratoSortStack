/**
 * Recurring themes among uncategorized files, offered as "Create a Smart
 * Folder for <theme>". The first version grouped on one field by exact text;
 * for a file whose contents could not be read that field was its own name,
 * so no group ever reached the threshold and the suggestion never showed.
 */
import {
  findClosestFolderGroup,
  findRecurringTheme,
  CLOSEST_MIN_FILES,
  THEME_MIN_FILES
} from '../../src/renderer/components/organize/uncategorizedThemes';

const file = (name, analysis) => ({ name, path: `/downloads/${name}`, analysis });

describe('findRecurringTheme', () => {
  test('files whose only "entity" is their own name do not form groups', () => {
    // What a filename-only analysis looks like: project = the file's stem.
    const files = ['fw4.pdf', 'scan-2025-03-19.docx', 'sales-deck.pptx'].map((name) =>
      file(name, { project: name.replace(/\.[^.]+$/, ''), category: 'Uncategorized' })
    );
    expect(findRecurringTheme(files)).toBeNull();
  });

  test('a shared keyword forms a theme once enough files carry it', () => {
    const files = [
      file('ARO+killflash+_stls.zip', { keywords: ['stl', 'killflash'] }),
      file('AR+15+foregrip_stls.zip', { keywords: ['stl', 'foregrip'] }),
      file('porta+spruzzino_stls.zip', { keywords: ['stl', 'porta'] }),
      file('notes.txt', { keywords: ['notes'] })
    ];
    const theme = findRecurringTheme(files);
    expect(theme).toEqual(expect.objectContaining({ displayName: 'Stl', source: 'keyword' }));
    expect(theme.files).toHaveLength(3);
  });

  test('a named entity and the same word as a keyword count together', () => {
    const files = [
      file('0-steps.png', { entity: 'Stratosort', keywords: ['screenshot'] }),
      file('how-to-use.mp4', { keywords: ['stratosort', 'navigation'] }),
      file('1-folders.png', { keywords: ['StratoSort', 'configure'] })
    ];
    const theme = findRecurringTheme(files);
    expect(theme.files).toHaveLength(3);
    // The entity's spelling is the one shown.
    expect(theme).toEqual(expect.objectContaining({ displayName: 'Stratosort', source: 'entity' }));
  });

  test('form words such as file types and "document" never become a theme', () => {
    const files = ['a', 'b', 'c', 'd'].map((n) =>
      file(`${n}.pdf`, { keywords: ['pdf', 'document', 'Uncategorized', '2026'] })
    );
    expect(findRecurringTheme(files)).toBeNull();
  });

  test(`fewer than ${THEME_MIN_FILES} files is not a theme`, () => {
    const files = [
      file('letter.pdf', { keywords: ['relationship'] }),
      file('photo.jpg', { keywords: ['relationship'] })
    ];
    expect(findRecurringTheme(files)).toBeNull();
  });

  test('the largest theme wins', () => {
    const files = [
      file('a.pdf', { keywords: ['music', 'tax'] }),
      file('b.pdf', { keywords: ['music', 'tax'] }),
      file('c.pdf', { keywords: ['music', 'tax'] }),
      file('d.pdf', { keywords: ['tax'] })
    ];
    expect(findRecurringTheme(files)).toEqual(expect.objectContaining({ displayName: 'Tax' }));
  });

  test('a named entity wins a tie with a keyword', () => {
    const files = ['a', 'b', 'c'].map((n) =>
      file(`${n}.pdf`, { vendor: 'Mercury', keywords: ['backup'] })
    );
    expect(findRecurringTheme(files)).toEqual(
      expect.objectContaining({ displayName: 'Mercury', source: 'entity' })
    );
  });

  test('no files, no theme', () => {
    expect(findRecurringTheme([])).toBeNull();
    expect(findRecurringTheme(undefined)).toBeNull();
  });
});

describe('findClosestFolderGroup', () => {
  const GSC = { id: 'g', name: 'excel GSc', path: '/out/gsc' };
  const BING = { id: 'b', name: 'Bing', path: '/out/bing' };
  const UNC = { id: 'u', name: 'Uncategorized', path: '/out/unc', isDefault: true };
  const FOLDERS = [GSC, BING, UNC];
  const held = (name, closest) => ({
    path: `/in/${name}`,
    name,
    routing: { source: 'review', engine: { needsReview: true, reviewClosest: closest } }
  });
  const resolve = (f) => f.routing;

  test('groups held files by the same closest folder and picks the largest group', () => {
    const files = [
      held('a.xlsx', 'excel GSc'),
      held('b.xlsx', 'Excel  gsc'),
      held('c.xlsx', 'excel GSc'),
      held('d.csv', 'Bing'),
      held('e.csv', 'Bing')
    ];
    const group = findClosestFolderGroup(files, resolve, FOLDERS);
    expect(group.folder).toBe(GSC);
    expect(group.files.map((f) => f.name)).toEqual(['a.xlsx', 'b.xlsx', 'c.xlsx']);
  });

  test('needs at least CLOSEST_MIN_FILES files', () => {
    expect(CLOSEST_MIN_FILES).toBe(2);
    expect(findClosestFolderGroup([held('a.xlsx', 'excel GSc')], resolve, FOLDERS)).toBeNull();
  });

  test('ignores files that are not held, folders that no longer exist and Uncategorized', () => {
    const routed = {
      path: '/in/x.xlsx',
      routing: { source: 'engine', engine: { reviewClosest: 'excel GSc' } }
    };
    const files = [
      routed,
      held('a.xlsx', 'Removed folder'),
      held('b.xlsx', 'Removed folder'),
      held('c.txt', 'Uncategorized'),
      held('d.txt', 'Uncategorized'),
      held('e.txt', null)
    ];
    expect(findClosestFolderGroup(files, resolve, FOLDERS)).toBeNull();
  });
});
