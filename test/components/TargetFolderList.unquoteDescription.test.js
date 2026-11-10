/**
 * Organize's target-folder cards show a folder's description inside curly
 * quotes and drop quotes the user typed around it. The character class that
 * does this held a literal `s` where `\s` was meant, so every description
 * lost the letter "s" at both ends: "Scans and receipts" read "cans and
 * receipt".
 */
import { unquoteDescription } from '../../src/renderer/components/organize/TargetFolderList';

describe('unquoteDescription', () => {
  test('keeps a description that starts and ends with the letter s', () => {
    expect(unquoteDescription('Scans and receipts')).toBe('Scans and receipts');
    expect(unquoteDescription('statements')).toBe('statements');
    expect(unquoteDescription('sss')).toBe('sss');
  });

  test('drops quotes typed around the text, of any kind', () => {
    expect(unquoteDescription('"Tax documents"')).toBe('Tax documents');
    expect(unquoteDescription("'Tax documents'")).toBe('Tax documents');
    expect(unquoteDescription('“Tax documents”')).toBe('Tax documents');
    expect(unquoteDescription('‘Tax documents’')).toBe('Tax documents');
  });

  test('drops whitespace inside the quotes as well as outside', () => {
    expect(unquoteDescription('  " Scans "  ')).toBe('Scans');
    expect(unquoteDescription('"\tstatements\n"')).toBe('statements');
  });

  test('keeps quotes and apostrophes inside the text', () => {
    expect(unquoteDescription('Sam\'s "final" drafts')).toBe('Sam\'s "final" drafts');
  });

  test('an empty or missing description stays empty', () => {
    expect(unquoteDescription('')).toBe('');
    expect(unquoteDescription(undefined)).toBe('');
    expect(unquoteDescription('""')).toBe('');
  });
});
