/**
 * isPathWithinAllowed with a drive or filesystem root as the base. A root
 * keeps its trailing separator after path.normalize/resolve ('D:\', '/'), so
 * the text after the prefix has no leading separator. That used to reject
 * every file under a smart folder at the root of a drive in strict file-ops
 * mode.
 */

const path = require('path');
const { isPathWithinAllowed } = require('../src/shared/pathSanitization');

const isWindows = process.platform === 'win32';

describe('isPathWithinAllowed with a root base', () => {
  (isWindows ? test : test.skip)('accepts files under a drive root (win32)', () => {
    expect(isPathWithinAllowed('D:\\Photos\\a.jpg', ['D:\\'])).toBe(true);
    expect(isPathWithinAllowed('d:\\photos\\a.jpg', [path.resolve('D:\\')])).toBe(true);
    expect(isPathWithinAllowed('D:\\', ['D:\\'])).toBe(true);
  });

  (isWindows ? test : test.skip)('still rejects other drives (win32)', () => {
    expect(isPathWithinAllowed('E:\\x', ['D:\\'])).toBe(false);
    expect(isPathWithinAllowed('E:\\Photos\\a.jpg', ['D:\\'])).toBe(false);
  });

  (isWindows ? test.skip : test)('accepts files under the filesystem root (posix)', () => {
    expect(isPathWithinAllowed('/mnt/data/a.jpg', ['/'])).toBe(true);
  });

  test('a base given with a trailing separator accepts its children', () => {
    const base = path.resolve('strato-root-base-test') + path.sep;
    expect(isPathWithinAllowed(path.join(base, 'child', 'a.txt'), [base])).toBe(true);
  });

  test('still rejects a sibling that only shares the name prefix', () => {
    const base = path.resolve('strato-root-base-test', 'foo');
    expect(isPathWithinAllowed(base + 'bar' + path.sep + 'a.txt', [base])).toBe(false);
    expect(isPathWithinAllowed(base + 'bar' + path.sep + 'a.txt', [base + path.sep])).toBe(false);
  });
});
