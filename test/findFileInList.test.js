import {
  fileMatchesFocusTarget,
  findFileIndexByPathOrName,
  pathsMatch
} from '../src/renderer/utils/findFileInList';

describe('findFileInList', () => {
  const files = [
    { path: 'C:\\Users\\me\\Downloads\\report.pdf', name: 'report.pdf' },
    { path: '/home/user/docs/invoice.pdf', name: 'invoice.pdf' }
  ];

  test('matches by canonical path', () => {
    expect(findFileIndexByPathOrName(files, 'C:/Users/me/Downloads/report.pdf', null)).toBe(0);
  });

  test('matches by file name when path differs', () => {
    expect(findFileIndexByPathOrName(files, null, 'invoice.pdf')).toBe(1);
  });

  test('fileMatchesFocusTarget checks multiple path fields', () => {
    expect(
      fileMatchesFocusTarget(
        { destination: '/home/user/docs/invoice.pdf' },
        '/home/user/docs/invoice.pdf',
        null
      )
    ).toBe(true);
  });

  test('pathsMatch normalizes separators', () => {
    expect(pathsMatch('C:\\a\\b.txt', 'C:/a/b.txt')).toBe(true);
  });
});
