/**
 * Folder keys answer one question for the renderer: "is this file already in
 * that folder?". The answer is advice shown to the user (a notice, a badge),
 * so a missed match is harmless and a false match is not.
 */

import { toFolderKey, toParentFolderKey } from '../src/renderer/utils/canonicalPath';

describe('toFolderKey', () => {
  test('one Windows folder has one key however it is spelled', () => {
    const key = toFolderKey('C:\\Users\\Hans\\Strato Input');
    expect(key).toBe('c:/users/hans/strato input');
    expect(toFolderKey('c:/users/hans/strato input/')).toBe(key);
    expect(toFolderKey('C:\\Users\\Hans\\\\Strato Input\\')).toBe(key);
  });

  test('a POSIX folder keeps its case and loses a trailing slash', () => {
    expect(toFolderKey('/Volumes/SSD/Strato Input/')).toBe('/Volumes/SSD/Strato Input');
    expect(toFolderKey('/Volumes/SSD/strato input')).not.toBe(
      toFolderKey('/Volumes/SSD/Strato Input')
    );
  });

  test('a name macOS lists decomposed matches the composed spelling', () => {
    const composed = '/Users/hans/Caf\u00e9';
    const decomposed = '/Users/hans/Cafe\u0301';
    expect(decomposed).not.toBe(composed);
    expect(toFolderKey(decomposed)).toBe(toFolderKey(composed));
  });

  test('a root is its drive, or empty for /', () => {
    expect(toFolderKey('C:\\')).toBe('c:');
    expect(toFolderKey('/')).toBe('');
  });

  test('no path gives null, which matches nothing', () => {
    expect(toFolderKey('')).toBeNull();
    expect(toFolderKey(undefined)).toBeNull();
    expect(toFolderKey(42)).toBeNull();
  });
});

describe('toParentFolderKey', () => {
  test('is the key of the folder that holds the file', () => {
    expect(toParentFolderKey('C:\\Users\\Hans\\Strato Input\\report.csv')).toBe(
      toFolderKey('C:\\Users\\Hans\\Strato Input')
    );
    expect(toParentFolderKey('/Volumes/SSD/Strato Input/report.csv')).toBe(
      toFolderKey('/Volumes/SSD/Strato Input/')
    );
  });

  test('a file in a subfolder is not in the folder above it', () => {
    expect(toParentFolderKey('/in/2025/report.csv')).not.toBe(toFolderKey('/in'));
  });

  test('a folder whose name starts the same is a different folder', () => {
    expect(toParentFolderKey('/in/Strato Input 2/report.csv')).not.toBe(
      toFolderKey('/in/Strato Input')
    );
  });

  test('a file at a root has the root key', () => {
    expect(toParentFolderKey('C:\\report.csv')).toBe(toFolderKey('C:\\'));
    expect(toParentFolderKey('/report.csv')).toBe(toFolderKey('/'));
  });

  test('a decomposed folder name matches the composed folder', () => {
    expect(toParentFolderKey('/Users/hans/Cafe\u0301/menu.pdf')).toBe(
      toFolderKey('/Users/hans/Caf\u00e9')
    );
  });

  test('a bare name or no path has no folder', () => {
    expect(toParentFolderKey('report.csv')).toBeNull();
    expect(toParentFolderKey('')).toBeNull();
    expect(toParentFolderKey(null)).toBeNull();
  });
});
