/**
 * @jest-environment node
 *
 * Registering a Smart Folder makes its path a trusted destination for every
 * later move. The bar for registering one is therefore the bar a destination
 * meets, and a folder picked to be scanned is not a folder picked for files.
 */
'use strict';

const policy = require('../src/main/ipc/files/destinationPolicy');

const {
  authorizeSmartFolderRoot,
  isUserChosenLocation,
  rememberUserChosenLocation,
  DESTINATION_ERROR_CODES,
  _resetDestinationPolicyForTests
} = policy;

const POSIX = {
  platform: 'linux',
  home: '/home/kim',
  env: {},
  app: {
    isPackaged: true,
    getPath: (name) =>
      name === 'userData' ? '/home/kim/.config/StratoSort' : '/home/kim/Downloads'
  }
};

function approvingDialog() {
  return { showMessageBox: jest.fn(async () => ({ response: 0 })) };
}

function decliningDialog() {
  return { showMessageBox: jest.fn(async () => ({ response: 1 })) };
}

describe('authorizeSmartFolderRoot', () => {
  beforeEach(() => {
    _resetDestinationPolicyForTests();
  });

  test('a startup folder is refused without a dialog', async () => {
    const dialog = approvingDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/.config/autostart', {
      ...POSIX,
      dialog
    });
    expect(decision).toEqual(
      expect.objectContaining({ allowed: false, errorCode: DESTINATION_ERROR_CODES.AUTOSTART })
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a folder picked in a dialog this session needs no prompt', async () => {
    rememberUserChosenLocation('/home/kim/Projects/Taxes', 'linux');
    expect(isUserChosenLocation('/home/kim/Projects/Taxes', 'linux')).toBe(true);
    expect(isUserChosenLocation('/home/kim/Projects', 'linux')).toBe(false);

    const dialog = decliningDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/Projects/Taxes', {
      ...POSIX,
      dialog
    });
    expect(decision).toEqual({ allowed: true, reason: 'session-folder' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a folder under a known root (Documents, an existing Smart Folder) needs no prompt', async () => {
    const dialog = decliningDialog();
    const underDocuments = await authorizeSmartFolderRoot('/home/kim/Documents/Taxes', {
      ...POSIX,
      dialog,
      knownRoots: ['/home/kim/Documents', '/mnt/nas/Sorted']
    });
    expect(underDocuments).toEqual({ allowed: true, reason: 'known-root' });
    const underSmartFolder = await authorizeSmartFolderRoot('/mnt/nas/Sorted/2025', {
      ...POSIX,
      dialog,
      knownRoots: ['/home/kim/Documents', '/mnt/nas/Sorted']
    });
    expect(underSmartFolder).toEqual({ allowed: true, reason: 'known-root' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a sibling of a known root is not under it', async () => {
    const dialog = decliningDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/Documents-old', {
      ...POSIX,
      dialog,
      knownRoots: ['/home/kim/Documents']
    });
    expect(decision.allowed).toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('renaming a Smart Folder beside the one it replaces needs no prompt', async () => {
    const dialog = decliningDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/Projects/Taxes 2025', {
      ...POSIX,
      dialog,
      sourcePath: '/home/kim/Projects/Taxes'
    });
    expect(decision).toEqual({ allowed: true, reason: 'same-folder' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('any other folder is put to the user with Smart Folder wording, and a decline is a refusal', async () => {
    const dialog = decliningDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/Projects/Taxes', {
      ...POSIX,
      dialog
    });
    expect(decision).toEqual(
      expect.objectContaining({ allowed: false, errorCode: DESTINATION_ERROR_CODES.NOT_ALLOWED })
    );
    const options = dialog.showMessageBox.mock.calls[0].at(-1);
    expect(options.message).toBe('Use /home/kim/Projects/Taxes as a Smart Folder?');
    expect(options.detail).toMatch(/without asking again/);
  });

  test('an approved folder is remembered, so the moves into it that follow need no prompt', async () => {
    const dialog = approvingDialog();
    const decision = await authorizeSmartFolderRoot('/home/kim/Projects/Taxes', {
      ...POSIX,
      dialog
    });
    expect(decision).toEqual({ allowed: true, reason: 'confirmed' });
    expect(isUserChosenLocation('/home/kim/Projects/Taxes', 'linux')).toBe(true);

    const move = await policy.authorizeDestination('/home/kim/Projects/Taxes/w2.pdf', {
      ...POSIX,
      dialog
    });
    expect(move).toEqual({ allowed: true, reason: 'session-folder' });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('a missing path is refused', async () => {
    const decision = await authorizeSmartFolderRoot('', POSIX);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing');
  });
});
