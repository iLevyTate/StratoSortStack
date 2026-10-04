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

  test('an unknown code falls back to the handler message', () => {
    const mapped = mapErrorToNotification({
      error: 'Invalid destination path: something odd',
      errorCode: 'NO_SUCH_CODE'
    });
    expect(mapped.message).toBe('Invalid destination path: something odd');
  });
});
