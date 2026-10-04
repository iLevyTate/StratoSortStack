/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// The "Create directory" button on a missing smart folder goes through
// SetupPhase.createSingleFolder -> filesIpc.createFolder. The preload returns
// the handler's envelope as-is (no throwIfFailed on files.createFolder), so a
// destination-policy refusal (the user cancelled the "Create the folder in
// ...?" prompt, or the parent is a startup folder / unapproved UNC share)
// arrives as a RESOLVED `{ success: false, error, errorCode }`, never as a
// rejection. These tests pin that the refusal reaches the user as a failure
// and that a genuine success still reports the directory as created.

const mockCreateFolder = jest.fn();
const mockAddNotification = jest.fn();

// Stable identities matter: SetupPhase keys its init effect on `dispatch`
// (via `actions` -> `loadSmartFolders`), so a hook mock that hands back a
// fresh function per render re-runs the async init forever and `act` never
// settles.
const mockDispatch = jest.fn();
const mockNotificationApi = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  showInfo: jest.fn(),
  addNotification: mockAddNotification
};

const FOLDER = {
  id: 'folder-1',
  name: 'Receipts',
  path: 'C:\\Users\\me\\Documents\\Receipts',
  physicallyExists: false
};

const storeState = {
  system: {
    documentsPath: 'C:\\Users\\me\\Documents',
    redactPaths: false,
    redactPathsLoaded: true
  },
  files: { smartFolders: [] },
  ui: { currentPhase: 'setup' }
};

jest.mock('react-redux', () => ({
  useSelector: (selector) => selector(storeState),
  useDispatch: () => mockDispatch
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: {
    createFolder: (...args) => mockCreateFolder(...args),
    selectDirectory: jest.fn(),
    getDocumentsPath: jest.fn(),
    openFolder: jest.fn()
  },
  settingsIpc: {
    get: jest.fn(async () => ({}))
  },
  smartFoldersIpc: {
    get: jest.fn(async () => [FOLDER]),
    add: jest.fn(),
    edit: jest.fn(),
    delete: jest.fn(),
    resetToDefaults: jest.fn(),
    generateDescription: jest.fn()
  }
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => mockNotificationApi
}));

jest.mock('../../src/renderer/hooks', () => ({
  useConfirmDialog: () => ({
    showConfirm: jest.fn(),
    ConfirmDialog: () => null
  })
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
  IconButton: ({ icon, ...props }) => <button {...props}>{icon}</button>,
  MinimizableGuideCard: ({ children }) => <div>{children}</div>,
  StateMessage: ({ title }) => <div>{title}</div>,
  StatusBadge: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children }) => <h2>{children}</h2>,
  Text: ({ children }) => <span>{children}</span>,
  Caption: ({ children }) => <span>{children}</span>
}));

jest.mock('../../src/renderer/components/layout', () => ({
  ActionBar: ({ children }) => <div>{children}</div>,
  Inline: ({ children }) => <div>{children}</div>,
  Stack: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/LoadingSkeleton', () => ({
  SmartFolderSkeleton: () => null
}));

jest.mock('../../src/renderer/components/setup/WatcherStatusLine', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../src/renderer/components/setup/SmartFolderAIOverrideField', () => ({
  __esModule: true,
  default: () => null
}));

// Keep the real SmartFolderItem: it owns the "Created directory" notice this
// test is about. Only the add modal is stubbed.
jest.mock('../../src/renderer/components/setup', () => ({
  SmartFolderItem: jest.requireActual('../../src/renderer/components/setup/SmartFolderItem')
    .default,
  AddSmartFolderModal: () => null
}));

import SetupPhase from '../../src/renderer/phases/SetupPhase';

async function renderAndOpenCreateButton() {
  render(<SetupPhase />);
  // Compact cards collapse by default; expanding reveals the footer actions.
  const card = await screen.findByTestId('folder-item');
  await act(async () => {
    fireEvent.click(card);
  });
  return screen.findByTitle('Create directory');
}

describe('SetupPhase createSingleFolder honours the handler envelope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a destination-policy refusal is reported as a failure, not as "Created"', async () => {
    mockCreateFolder.mockResolvedValue({
      success: false,
      error: 'Folder location was not approved',
      errorCode: 'DESTINATION_NOT_ALLOWED'
    });

    const createButton = await renderAndOpenCreateButton();
    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(mockAddNotification).toHaveBeenCalled());
    expect(mockCreateFolder).toHaveBeenCalledWith(FOLDER.path);
    expect(mockAddNotification).not.toHaveBeenCalledWith(
      expect.stringContaining('Created directory'),
      expect.anything()
    );
    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create'),
      'error'
    );
    // The policy code is run through errorMapping, so the user sees the
    // actionable copy for DESTINATION_NOT_ALLOWED rather than a bare string.
    const [message] = mockAddNotification.mock.calls[0];
    expect(message).toContain('That folder was not approved');
  });

  test('a refusal without a mapped code still surfaces the handler message', async () => {
    mockCreateFolder.mockResolvedValue({
      success: false,
      error: 'Insufficient disk space',
      errorCode: 'NO_SPACE'
    });

    const createButton = await renderAndOpenCreateButton();
    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() => expect(mockAddNotification).toHaveBeenCalled());
    expect(mockAddNotification).toHaveBeenCalledWith(
      'Failed to create: Insufficient disk space',
      'error'
    );
  });

  test('a genuine success still reports the directory as created', async () => {
    mockCreateFolder.mockResolvedValue({
      success: true,
      message: 'Folder created successfully',
      path: FOLDER.path,
      alreadyExisted: false
    });

    const createButton = await renderAndOpenCreateButton();
    await act(async () => {
      fireEvent.click(createButton);
    });

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        `Created directory: ${FOLDER.name}`,
        'success'
      )
    );
    expect(mockAddNotification).not.toHaveBeenCalledWith(expect.anything(), 'error');
  });
});
