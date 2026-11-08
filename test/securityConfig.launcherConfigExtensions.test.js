/**
 * Files that are configuration for a program which then runs something must
 * never be handed to shell.openPath, the same as .settingcontent-ms /
 * .library-ms / .appref-ms.
 */
const { isExecutableExtension } = require('../src/shared/securityConfig');

describe('isExecutableExtension: launcher configuration files', () => {
  test.each([
    ['.wsb', 'Windows Sandbox config: runs its LogonCommand with host folders mapped'],
    ['.rdp', 'Remote Desktop connection: connects out with embedded drive redirection'],
    ['.ppkg', 'Provisioning package: installs settings/apps on open']
  ])('blocks %s (%s)', (ext) => {
    expect(isExecutableExtension(`C:/Users/u/Downloads/x${ext}`)).toBe(true);
    expect(isExecutableExtension(`/home/u/Downloads/X${ext.toUpperCase()}`)).toBe(true);
    expect(isExecutableExtension(`x${ext}.`)).toBe(true);
  });
});
