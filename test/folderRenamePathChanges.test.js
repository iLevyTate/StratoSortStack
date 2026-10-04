/**
 * K-08: a smart-folder rename physically moves every file inside it, so the
 * knowledge (history entries, vectors, chunks, graph ids) has to follow.
 * buildFolderRenamePathChanges turns the history into the {oldPath,newPath}
 * pairs FilePathCoordinator.batchPathUpdate expects. Pure, no fs.
 */
const { buildFolderRenamePathChanges } = require('../src/main/utils/folderRenamePathChanges');

describe('buildFolderRenamePathChanges', () => {
  const entries = [
    { originalPath: 'C:\\Docs\\Old\\a.txt', organization: {} },
    {
      originalPath: 'C:\\Docs\\elsewhere\\b.txt',
      organization: { actual: 'C:\\Docs\\Old\\sub\\b.txt' }
    },
    { originalPath: 'C:\\Docs\\Older\\c.txt', organization: {} },
    { originalPath: 'C:\\Docs\\Old\\a.txt', organization: {} }
  ];

  test('maps every current path under the old folder to the new folder, once', () => {
    const changes = buildFolderRenamePathChanges(entries, 'C:\\Docs\\Old', 'C:\\Docs\\New', {
      platform: 'win32'
    });
    expect(changes).toEqual([
      { oldPath: 'C:\\Docs\\Old\\a.txt', newPath: 'C:\\Docs\\New\\a.txt' },
      { oldPath: 'C:\\Docs\\Old\\sub\\b.txt', newPath: 'C:\\Docs\\New\\sub\\b.txt' }
    ]);
  });

  test('prefers the organized (actual) path over the original path', () => {
    const moved = [
      {
        originalPath: 'C:\\Docs\\Old\\moved-out.txt',
        organization: { actual: 'C:\\Archive\\moved-out.txt' }
      }
    ];
    expect(
      buildFolderRenamePathChanges(moved, 'C:\\Docs\\Old', 'C:\\Docs\\New', { platform: 'win32' })
    ).toEqual([]);
  });

  test('is case-insensitive on win32 and case-sensitive elsewhere', () => {
    const e = [{ originalPath: 'C:\\docs\\OLD\\x.txt', organization: {} }];
    expect(
      buildFolderRenamePathChanges(e, 'C:\\Docs\\Old', 'C:\\Docs\\New', { platform: 'win32' })
    ).toHaveLength(1);
    const posix = [{ originalPath: '/docs/OLD/x.txt', organization: {} }];
    expect(
      buildFolderRenamePathChanges(posix, '/docs/old', '/docs/new', { platform: 'linux' })
    ).toHaveLength(0);
    const posixExact = [{ originalPath: '/docs/old/x.txt', organization: {} }];
    expect(
      buildFolderRenamePathChanges(posixExact, '/docs/old/', '/docs/new', { platform: 'linux' })
    ).toEqual([{ oldPath: '/docs/old/x.txt', newPath: '/docs/new/x.txt' }]);
  });

  test('returns [] when old and new are the same folder', () => {
    expect(
      buildFolderRenamePathChanges(entries, 'C:\\Docs\\Old', 'C:\\Docs\\Old', { platform: 'win32' })
    ).toEqual([]);
    expect(
      buildFolderRenamePathChanges(entries, 'C:\\Docs\\Old', 'c:\\docs\\old\\', {
        platform: 'win32'
      })
    ).toEqual([]);
  });

  test('tolerates malformed input', () => {
    expect(buildFolderRenamePathChanges(null, 'C:\\A', 'C:\\B', { platform: 'win32' })).toEqual([]);
    expect(
      buildFolderRenamePathChanges([null, {}, { originalPath: 42 }], 'C:\\A', 'C:\\B', {
        platform: 'win32'
      })
    ).toEqual([]);
    expect(buildFolderRenamePathChanges(entries, '', 'C:\\B', { platform: 'win32' })).toEqual([]);
  });

  test('applies Windows rules to drive-letter paths even on a posix host', () => {
    const changes = buildFolderRenamePathChanges(
      [{ originalPath: 'C:\\Docs\\Old\\a.txt', organization: {} }],
      'C:\\Docs\\Old',
      'C:\\Docs\\New',
      { platform: undefined }
    );
    expect(changes).toEqual([{ oldPath: 'C:\\Docs\\Old\\a.txt', newPath: 'C:\\Docs\\New\\a.txt' }]);
  });

  test('matches case-insensitively on macOS and keeps the stored casing', () => {
    const changes = buildFolderRenamePathChanges(
      [{ originalPath: '/Users/me/docs/old/Report.PDF', organization: {} }],
      '/Users/me/Docs/Old',
      '/Users/me/Docs/New',
      { platform: 'darwin' }
    );
    expect(changes).toEqual([
      { oldPath: '/Users/me/docs/old/Report.PDF', newPath: '/Users/me/Docs/New/Report.PDF' }
    ]);
  });

  test('stays case-sensitive on Linux', () => {
    expect(
      buildFolderRenamePathChanges(
        [{ originalPath: '/home/me/docs/old/a.txt', organization: {} }],
        '/home/me/Docs/Old',
        '/home/me/Docs/New',
        { platform: 'linux' }
      )
    ).toEqual([]);
  });
});
