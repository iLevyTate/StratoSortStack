/**
 * The relative part of each history path must come from the case-preserved
 * path. toLowerCase() is not length-preserving ('İ' U+0130 becomes two UTF-16
 * units), so slicing the original path by the folded key's length used to
 * drop the first characters of every file name ("report.pdf" -> "eport.pdf").
 */
const { buildFolderRenamePathChanges } = require('../src/main/utils/folderRenamePathChanges');

describe('buildFolderRenamePathChanges with length-changing case folds', () => {
  test("win32: 'İ' in the renamed folder keeps file names intact", () => {
    const entries = [{ originalPath: 'C:\\Users\\a\\İzmir\\report.pdf' }];
    expect(
      buildFolderRenamePathChanges(entries, 'C:/Users/a/İzmir', 'C:/Users/a/Trips', {
        platform: 'win32'
      })
    ).toEqual([
      { oldPath: 'C:\\Users\\a\\İzmir\\report.pdf', newPath: 'C:\\Users\\a\\Trips\\report.pdf' }
    ]);
  });

  test("win32: 'İ' in a parent folder and a nested file", () => {
    const entries = [{ originalPath: 'C:\\Users\\İuser\\Docs\\Old\\sub\\notes.txt' }];
    expect(
      buildFolderRenamePathChanges(
        entries,
        'C:\\Users\\İuser\\Docs\\Old',
        'C:\\Users\\İuser\\Docs\\New',
        { platform: 'win32' }
      )
    ).toEqual([
      {
        oldPath: 'C:\\Users\\İuser\\Docs\\Old\\sub\\notes.txt',
        newPath: 'C:\\Users\\İuser\\Docs\\New\\sub\\notes.txt'
      }
    ]);
  });

  test("darwin: 'İ' in parent and renamed folder, history path cased differently", () => {
    const entries = [
      { originalPath: '/Users/İuser/İzmir/report.pdf' },
      // 'İ'.toLowerCase() is 'i' + U+0307, so this matches the folder on a
      // case-insensitive volume while being a different length.
      { originalPath: '/users/i\u0307user/i\u0307zmir/Photos/beach.jpg' }
    ];
    expect(
      buildFolderRenamePathChanges(entries, '/Users/İuser/İzmir', '/Users/İuser/Trips', {
        platform: 'darwin'
      })
    ).toEqual([
      { oldPath: '/Users/İuser/İzmir/report.pdf', newPath: '/Users/İuser/Trips/report.pdf' },
      {
        oldPath: '/users/i\u0307user/i\u0307zmir/Photos/beach.jpg',
        newPath: '/Users/İuser/Trips/Photos/beach.jpg'
      }
    ]);
  });

  test('win32: UNC roots still map by segment', () => {
    const entries = [{ originalPath: '\\\\server\\share\\İzmir\\a.txt' }];
    expect(
      buildFolderRenamePathChanges(
        entries,
        '\\\\server\\share\\İzmir',
        '\\\\server\\share\\Trips',
        {
          platform: 'win32'
        }
      )
    ).toEqual([
      { oldPath: '\\\\server\\share\\İzmir\\a.txt', newPath: '\\\\server\\share\\Trips\\a.txt' }
    ]);
  });
});
