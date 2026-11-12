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

  test('an unknown code falls back to the handler message', () => {
    const mapped = mapErrorToNotification({
      error: 'Invalid destination path: something odd',
      errorCode: 'NO_SUCH_CODE'
    });
    expect(mapped.message).toBe('Invalid destination path: something odd');
  });
});
