/**
 * @jest-environment node
 *
 * The file-operation handlers return their own codes (destinationPolicy,
 * fileOperationHandlers, batchOrganizeHandler). Until these were mapped the
 * organize notification said "check logs for details" for every refusal.
 */

const { mapErrorToNotification } = require('../src/renderer/utils/errorMapping');

describe('errorMapping: file operation codes', () => {
  test('a refused destination names the fix', () => {
    const mapped = mapErrorToNotification({
      error: 'Invalid destination path: Destination folder was not approved: /x',
      errorCode: 'DESTINATION_NOT_ALLOWED'
    });
    expect(mapped.severity).toBe('warning');
    expect(mapped.message).toMatch(/not approved/);
    expect(mapped.message).toMatch(/Smart Folder/);
  });

  test('a startup folder is an error, a network share and a cancel are warnings', () => {
    expect(mapErrorToNotification({ errorCode: 'DESTINATION_AUTOSTART' })).toMatchObject({
      severity: 'error',
      message: expect.stringMatching(/sign in/)
    });
    expect(mapErrorToNotification({ errorCode: 'DESTINATION_UNC' })).toMatchObject({
      severity: 'warning',
      message: expect.stringMatching(/Network folders/)
    });
    expect(mapErrorToNotification({ errorCode: 'ABORTED' })).toMatchObject({
      severity: 'warning',
      message: expect.stringMatching(/cancelled/)
    });
    expect(mapErrorToNotification({ errorCode: 'FILE_EXISTS' })).toMatchObject({
      message: expect.stringMatching(/already exists/)
    });
  });

  test('the code is also read from a result object carrying errorCode', () => {
    const mapped = mapErrorToNotification({
      error: { success: false, error: 'Invalid destination path', errorCode: 'DESTINATION_UNC' }
    });
    expect(mapped.message).toMatch(/Network folders/);
  });

  describe('LINK_INTO_SYSTEM (create folder through a link that leads into a system folder)', () => {
    const HANDLER_MESSAGE =
      'That folder leads into a system folder through a link or short name. Choose a different folder.';

    test('shows the handler message as is, as a warning', () => {
      const mapped = mapErrorToNotification({
        error: HANDLER_MESSAGE,
        errorCode: 'LINK_INTO_SYSTEM'
      });
      expect(mapped).toMatchObject({ severity: 'warning', message: HANDLER_MESSAGE });
    });

    test('a newer handler wording wins over the copy kept here', () => {
      const mapped = mapErrorToNotification({
        error: 'That folder is reached through a link. Choose the real folder.',
        errorCode: 'LINK_INTO_SYSTEM'
      });
      expect(mapped.message).toBe('That folder is reached through a link. Choose the real folder.');
      expect(mapped.severity).toBe('warning');
    });

    test('without a handler message it still says what to do', () => {
      expect(mapErrorToNotification({ errorCode: 'LINK_INTO_SYSTEM' })).toMatchObject({
        severity: 'warning',
        message: HANDLER_MESSAGE
      });
    });

    test('read from the result envelope too', () => {
      const mapped = mapErrorToNotification({
        error: { success: false, error: HANDLER_MESSAGE, errorCode: 'LINK_INTO_SYSTEM' }
      });
      // The envelope carries its text in `error`, not `message`; the mapped
      // copy is the same sentence.
      expect(mapped.message).toBe(HANDLER_MESSAGE);
    });
  });

  describe('SECURITY_PATH_VIOLATION (a folder path main refused)', () => {
    test('shows which rule the path broke, as an error', () => {
      const mapped = mapErrorToNotification({
        error: 'Invalid path: access to system directories is not allowed',
        errorCode: 'SECURITY_PATH_VIOLATION'
      });
      expect(mapped).toEqual(
        expect.objectContaining({
          severity: 'error',
          message: 'Invalid path: access to system directories is not allowed'
        })
      );
    });

    test('without a handler message it still says the location was refused', () => {
      expect(mapErrorToNotification({ errorCode: 'SECURITY_PATH_VIOLATION' })).toMatchObject({
        severity: 'error',
        message: 'Refused: that location cannot be used.'
      });
    });
  });

  describe('a move the check after it could not confirm', () => {
    const HANDLER_MESSAGE =
      'Move verification failed: destination does not exist after move: /dest/a.pdf. The file is still at its original location.';

    test('shows where the file is, not the generic save failure', () => {
      const mapped = mapErrorToNotification({
        error: HANDLER_MESSAGE,
        errorCode: 'MOVE_VERIFICATION_DESTINATION_FAILED'
      });
      expect(mapped).toMatchObject({ severity: 'error', message: HANDLER_MESSAGE });
    });

    test.each([
      ['MOVE_VERIFICATION_DESTINATION_FAILED', /not found at its destination/],
      ['MOVE_VERIFICATION_SOURCE_EXISTS', /still at its original location/]
    ])('%s without a handler message still says what happened', (errorCode, expected) => {
      expect(mapErrorToNotification({ errorCode })).toMatchObject({
        severity: 'error',
        message: expect.stringMatching(expected)
      });
    });
  });

  describe('a move between drives that lost its temporary copy', () => {
    const HANDLER_MESSAGE =
      'The temporary copy in /dest/Invoices was removed before the move finished. The original was not moved: /home/user/Downloads/a.pdf';

    test('shows which folder and that the original was not moved, not "File not found"', () => {
      const mapped = mapErrorToNotification({
        error: HANDLER_MESSAGE,
        errorCode: 'STAGED_COPY_FAILED'
      });
      expect(mapped).toMatchObject({ severity: 'error', message: HANDLER_MESSAGE });
    });

    test('without a handler message still says the original was not moved', () => {
      expect(mapErrorToNotification({ errorCode: 'STAGED_COPY_FAILED' })).toMatchObject({
        severity: 'error',
        message: expect.stringMatching(/The original file was not moved\.$/)
      });
    });
  });

  test('an unknown code falls back to the handler message', () => {
    const mapped = mapErrorToNotification({
      error: 'Invalid destination path: something odd',
      errorCode: 'NO_SUCH_CODE'
    });
    expect(mapped.message).toBe('Invalid destination path: something odd');
  });
});
