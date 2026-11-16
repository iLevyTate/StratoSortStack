/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Pointing a Smart Folder at a folder that does not exist yet used to move
// the old folder there, files and all, without asking. Main now changes
// nothing and replies PATH_CHANGE_CHOICE_REQUIRED; Setup asks: move the
// folder and its files, use a new empty folder, or cancel.
// (Harness from SetupPhase.destinationAdvice.test.js.)

const mockDispatch = jest.fn();
const mockNotificationApi = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  showInfo: jest.fn(),
  addNotification: jest.fn()
};
const mockEdit = jest.fn();
const mockShowChoice = jest.fn();

const UNCATEGORIZED = {
  id: 'default-uncategorized',
  name: 'Uncategorized',
  category: 'uncategorized',
  isDefault: true,
  description: "Default folder for files that don't match any smart folder",
  path: '/Users/alex/Documents/Uncategorized',
  physicallyExists: true
};
const REPORTS = {
  id: 'reports',
  name: 'Reports',
  description: 'Quarterly reports and the numbers behind them',
  path: '/Users/alex/Documents/Reports',
  physicallyExists: true
};
const NEW_PATH = '/Users/alex/Work/Reports';

const mockStoreState = {
  system: {
    documentsPath: '/Users/alex/Documents',
    redactPaths: false,
    redactPathsLoaded: true
  },
  files: { smartFolders: [] },
  ui: { currentPhase: 'setup', settings: { smartFolderWatchEnabled: true } },
  analysis: { results: [] }
};

jest.mock('react-redux', () => ({
  useSelector: (selector) => selector(mockStoreState),
  useDispatch: () => mockDispatch
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: {
    createFolder: jest.fn(),
    selectDirectory: jest.fn(),
    getDocumentsPath: jest.fn(),
    openFolder: jest.fn()
  },
  settingsIpc: {
    get: jest.fn(async () => ({}))
  },
  smartFoldersIpc: {
    get: jest.fn(async () => [UNCATEGORIZED, REPORTS]),
    add: jest.fn(),
    edit: (...args) => mockEdit(...args),
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
    showChoice: (...args) => mockShowChoice(...args),
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
  Text: ({ children, id }) => <span id={id}>{children}</span>,
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

jest.mock('../../src/renderer/components/setup', () => ({
  SmartFolderItem: jest.requireActual('../../src/renderer/components/setup/SmartFolderItem')
    .default,
  AddSmartFolderModal: () => null
}));

import SetupPhase from '../../src/renderer/phases/SetupPhase';

jest.setTimeout(30000);
const LOAD_TIMEOUT = { timeout: 10000 };

const choiceRequired = {
  success: false,
  errorCode: 'PATH_CHANGE_CHOICE_REQUIRED',
  error: 'The new location does not exist yet.',
  oldPath: REPORTS.path,
  newPath: NEW_PATH
};

async function changePathAndSave() {
  render(<SetupPhase />);
  await screen.findAllByTestId('folder-item', {}, LOAD_TIMEOUT);
  const card = screen
    .getAllByTestId('folder-item')
    .find((item) => item.textContent.includes('Reports'));
  await act(async () => {
    fireEvent.click(card);
  });
  const expanded = screen
    .getAllByTestId('folder-item')
    .find((item) => item.textContent.includes('Reports'));
  const editButton = Array.from(expanded.querySelectorAll('button')).find(
    (button) => button.getAttribute('title') === 'Edit folder'
  );
  await act(async () => {
    fireEvent.click(editButton);
  });
  fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: NEW_PATH } });
  await act(async () => {
    fireEvent.click(screen.getByText('Save changes'));
  });
}

describe('SetupPhase: a new path that does not exist yet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('asks first, naming both folders and the three ways out', async () => {
    mockEdit.mockResolvedValueOnce(choiceRequired);
    mockShowChoice.mockResolvedValue(null);

    await changePathAndSave();

    await waitFor(() => expect(mockShowChoice).toHaveBeenCalledTimes(1));
    const [question] = mockShowChoice.mock.calls[0];
    expect(question.message).toContain(REPORTS.path);
    expect(question.message).toContain(NEW_PATH);
    expect(question.confirmText).toBe('Move the folder and its files');
    expect(question.alternativeText).toBe('Use a new empty folder');
    expect(question.cancelText).toBe('Cancel');
  });

  test('Cancel changes nothing and keeps the editor open', async () => {
    mockEdit.mockResolvedValueOnce(choiceRequired);
    mockShowChoice.mockResolvedValue(null);

    await changePathAndSave();

    await waitFor(() => expect(mockShowChoice).toHaveBeenCalled());
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockNotificationApi.showSuccess).not.toHaveBeenCalled();
    expect(mockNotificationApi.showError).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Folder path')).toHaveValue(NEW_PATH);
  });

  test('"Move the folder and its files" sends the move and says what moved', async () => {
    mockEdit
      .mockResolvedValueOnce(choiceRequired)
      .mockResolvedValueOnce({ success: true, movedFolder: true });
    mockShowChoice.mockResolvedValue('confirm');

    await changePathAndSave();

    await waitFor(() => expect(mockEdit).toHaveBeenCalledTimes(2));
    expect(mockEdit.mock.calls[1][0]).toBe('reports');
    expect(mockEdit.mock.calls[1][2]).toEqual({ pathChange: 'move' });
    await waitFor(() =>
      expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
        'Moved "Reports" and its files to the new location.'
      )
    );
  });

  test('"Use a new empty folder" leaves the old folder and its files where they are', async () => {
    mockEdit
      .mockResolvedValueOnce(choiceRequired)
      .mockResolvedValueOnce({ success: true, movedFolder: false });
    mockShowChoice.mockResolvedValue('alternative');

    await changePathAndSave();

    await waitFor(() => expect(mockEdit).toHaveBeenCalledTimes(2));
    expect(mockEdit.mock.calls[1][2]).toEqual({ pathChange: 'new' });
    await waitFor(() =>
      expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
        'Updated "Reports". It now uses a new empty folder. The old folder and its files stay where they are.'
      )
    );
  });

  test('a new path that already exists is saved without asking', async () => {
    mockEdit.mockResolvedValueOnce({ success: true, movedFolder: false });

    await changePathAndSave();

    await waitFor(() => expect(mockNotificationApi.showSuccess).toHaveBeenCalled());
    expect(mockShowChoice).not.toHaveBeenCalled();
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit.mock.calls[0]).toHaveLength(2);
  });
});
