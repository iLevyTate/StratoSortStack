/**
 * @jest-environment node
 *
 * A folder StratoSort cannot write to or open: main says why (read-only
 * drive, macOS Privacy & Security), so that text is what the person sees.
 */

const { mapErrorToNotification } = require('../src/renderer/utils/errorMapping');

describe('errorMapping: folder access codes', () => {
  test('PARENT_NOT_WRITABLE shows the reason main gave', () => {
    const mapped = mapErrorToNotification({
      error: 'This drive is read-only, so StratoSort cannot put files on it.',
      errorCode: 'PARENT_NOT_WRITABLE'
    });
    expect(mapped.message).toBe('This drive is read-only, so StratoSort cannot put files on it.');
    expect(mapped.severity).toBe('error');
  });

  test('PARENT_NOT_WRITABLE without a reason falls back to plain words', () => {
    expect(mapErrorToNotification({ errorCode: 'PARENT_NOT_WRITABLE' }).message).toBe(
      'StratoSort cannot write to this folder.'
    );
  });

  test('FOLDER_NOT_READABLE shows the reason main gave', () => {
    const mapped = mapErrorToNotification({ error: 'X', errorCode: 'FOLDER_NOT_READABLE' });
    expect(mapped).toMatchObject({ message: 'X', severity: 'error' });
  });

  test('FOLDER_NOT_READABLE without a reason falls back to plain words', () => {
    expect(mapErrorToNotification({ errorCode: 'FOLDER_NOT_READABLE' }).message).toBe(
      'StratoSort cannot open this folder.'
    );
  });
});
