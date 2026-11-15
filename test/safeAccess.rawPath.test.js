/**
 * safeFilePath must hand back the path exactly as given. File names can
 * legitimately contain percent escapes ("Q3%20report.pdf") or surrounding
 * spaces, and decoding or trimming them pointed analyze/organize at a
 * different (or missing) file. Decoding is only used to spot traversal.
 */
const { safeFilePath } = require('../src/main/utils/safeAccess');

describe('safeFilePath keeps real paths unchanged', () => {
  test.each([
    'C:/Users/a/Downloads/Q3%20report.pdf',
    '/home/a/Downloads/100%25.txt',
    '/home/a/Downloads/50% off.pdf',
    '/home/a/ leading-space.txt',
    '/home/a/trailing-space.txt ',
    'C:\\Users\\a\\..hidden\\file..txt'
  ])('%s is returned as-is', (p) => {
    expect(safeFilePath(p)).toBe(p);
  });

  test.each([
    '/x/../y',
    'C:\\x\\..\\y',
    '/x/%2e%2e/y',
    '/x/%2e%2e%2fy',
    'C:\\x\\%2E%2E%5Cy',
    '/x/%252e%252e%252fy',
    '/x/%2e%2e/y%zz'
  ])('traversal %s is rejected', (p) => {
    expect(safeFilePath(p)).toBeNull();
  });

  test('control characters are rejected rather than stripped', () => {
    expect(safeFilePath('/path\0to/file.txt')).toBeNull();
    expect(safeFilePath('/path/\x07file.txt')).toBeNull();
  });

  test('whitespace-only input is rejected', () => {
    expect(safeFilePath('   ')).toBeNull();
  });
});
