/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Setup has to say what Smart Folders are for (where files go) and what the
// app does when one is added or changed, and warn, without blocking, about
// folder lists the AI cannot use well: one Smart Folder inside another, more
// folders than the AI compares at once, and descriptions that say too little.
// The catch-all keeps its name.

const mockDispatch = jest.fn();
const mockNotificationApi = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  showInfo: jest.fn(),
  addNotification: jest.fn()
};
const mockAdd = jest.fn();
const mockEdit = jest.fn();
const mockModalProps = { current: null };

const UNCATEGORIZED = {
  id: 'default-uncategorized',
  name: 'Uncategorized',
  category: 'uncategorized',
  isDefault: true,
  description: "Default folder for files that don't match any smart folder",
  path: '/Users/h/Documents/Uncategorized',
  physicallyExists: true
};
const OUTPUT = {
  id: 'out',
  name: 'Test Folder',
  description: 'Everything sorted out of the input folder for the test run',
  path: '/Users/h/Public/Strato Output',
  physicallyExists: true
};
const GSC = {
  id: 'gsc',
  name: 'GSC',
  description: 'Google Search Console performance exports with queries pages clicks',
  path: '/Users/h/Public/Strato Output/GSC',
  physicallyExists: true
};

let mockFolders = [UNCATEGORIZED];

const mockStoreState = {
  system: {
    documentsPath: '/Users/h/Documents',
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
    get: jest.fn(async () => mockFolders),
    add: (...args) => mockAdd(...args),
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
  AddSmartFolderModal: (props) => {
    mockModalProps.current = props;
    return null;
  }
}));

import SetupPhase from '../../src/renderer/phases/SetupPhase';
import { TRUNCATION } from '../../src/shared/performanceConstants';

// The folder list loads through a mocked IPC call; give it room on a busy machine.
jest.setTimeout(30000);
const LOAD_TIMEOUT = { timeout: 10000 };

async function renderSetup() {
  render(<SetupPhase />);
  await screen.findAllByTestId('folder-item', {}, LOAD_TIMEOUT);
}

async function openEditor(folderName) {
  const card = screen
    .getAllByTestId('folder-item')
    .find((item) => item.textContent.includes(folderName));
  await act(async () => {
    fireEvent.click(card);
  });
  const expanded = screen
    .getAllByTestId('folder-item')
    .find((item) => item.textContent.includes(folderName));
  const editButton = Array.from(expanded.querySelectorAll('button')).find(
    (button) => button.getAttribute('title') === 'Edit folder'
  );
  await act(async () => {
    fireEvent.click(editButton);
  });
}

describe('SetupPhase destination advice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFolders = [UNCATEGORIZED];
    mockStoreState.ui.settings = { smartFolderWatchEnabled: true };
    mockStoreState.analysis.results = [];
  });

  test('says Smart Folders are where files go', async () => {
    await renderSetup();
    expect(screen.getByText(/Smart Folders are where your files go\./)).toBeInTheDocument();
  });

  test('a Smart Folder inside another one gets a note that does not block Continue', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT, GSC];
    await renderSetup();

    expect(
      await screen.findByText(
        /"GSC" is inside another Smart Folder, "Test Folder"\. Files sorted into "Test Folder" will sit next to the "GSC" folder\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Continue to Discovery')).not.toBeDisabled();
  });

  test('no nesting note for side-by-side folders', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT];
    await renderSetup();
    expect(screen.queryByText(/is inside another Smart Folder/)).not.toBeInTheDocument();
  });

  test('more Smart Folders than the AI compares at once is called out', async () => {
    const max = TRUNCATION.PROMPT_FOLDERS_MAX;
    mockFolders = [
      UNCATEGORIZED,
      ...Array.from({ length: max + 2 }, (_, i) => ({
        id: `f${i}`,
        name: `Folder ${i}`,
        description: `Reports and exports for client number ${i} only`,
        path: `/Users/h/Documents/Folder ${i}`,
        physicallyExists: true
      }))
    ];
    await renderSetup();

    expect(
      await screen.findByText(
        new RegExp(`compare a file with ${max} Smart Folders at a time`),
        {},
        LOAD_TIMEOUT
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/so 3 of them are left out/)).toBeInTheDocument();
  });

  test('no folder-count warning at the limit', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT];
    await renderSetup();
    expect(screen.queryByText(/Smart Folders at a time/)).not.toBeInTheDocument();
  });

  test('adding a folder that already holds files says they are analyzed and nothing moves', async () => {
    mockAdd.mockResolvedValue({ success: true, directoryExisted: true });
    await renderSetup();

    await act(async () => {
      await mockModalProps.current.onAdd({ name: 'GSC', path: '/Users/h/GSC' });
    });

    expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
      'Added "GSC". Files already in it are being analyzed in the background so search can find them. Nothing is moved.'
    );
  });

  test('with folder watching off the add message does not promise analysis', async () => {
    mockStoreState.ui.settings = { smartFolderWatchEnabled: false };
    mockAdd.mockResolvedValue({ success: true, directoryExisted: true });
    await renderSetup();

    await act(async () => {
      await mockModalProps.current.onAdd({ name: 'GSC', path: '/Users/h/GSC' });
    });

    expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith('Added "GSC". Nothing is moved.');
  });

  test('a new, empty folder keeps the "created directory" message', async () => {
    mockAdd.mockResolvedValue({ success: true, directoryCreated: true });
    await renderSetup();

    await act(async () => {
      await mockModalProps.current.onAdd({ name: 'GSC', path: '/Users/h/GSC' });
    });

    expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
      'Added smart folder and created directory: GSC'
    );
  });

  test('pointing a folder somewhere else says the new location is analyzed', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT];
    mockEdit.mockResolvedValue({ success: true });
    await renderSetup();
    await openEditor('Test Folder');

    fireEvent.change(screen.getByLabelText('Folder path'), {
      target: { value: '/Users/h/Public/Strato Sorted' }
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save changes'));
    });

    await waitFor(() =>
      expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
        'Updated "Test Folder". Files in the new location are being analyzed in the background. Nothing is moved.'
      )
    );
  });

  test('a new description after analysis says how it reaches files already analyzed', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT];
    mockStoreState.analysis.results = [{ path: '/Users/h/a.pdf' }];
    mockEdit.mockResolvedValue({ success: true });
    await renderSetup();
    await openEditor('Test Folder');

    fireEvent.change(screen.getByLabelText('Folder description'), {
      target: { value: 'Search console and Bing exports from the March test run' }
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save changes'));
    });

    await waitFor(() =>
      expect(mockNotificationApi.showSuccess).toHaveBeenCalledWith(
        expect.stringContaining('Organize uses the new description for files you already analyzed')
      )
    );
  });

  test('the Uncategorized folder name cannot be edited, and says why', async () => {
    await renderSetup();
    await openEditor('Uncategorized');

    const nameInput = screen.getByLabelText('Folder name');
    expect(nameInput).toBeDisabled();
    expect(
      screen.getByText('Files that fit no other folder go here. Its name cannot change.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Folder path')).not.toBeDisabled();
  });

  test('an ordinary folder name stays editable', async () => {
    mockFolders = [UNCATEGORIZED, OUTPUT];
    await renderSetup();
    await openEditor('Test Folder');
    expect(screen.getByLabelText('Folder name')).not.toBeDisabled();
  });

  test('a folder with no description is flagged on its card and in the editor', async () => {
    mockFolders = [UNCATEGORIZED, { ...OUTPUT, description: 'Smart folder for Test Folder' }];
    await renderSetup();

    expect(screen.getByText(/^Add a description\./)).toBeInTheDocument();

    await openEditor('Test Folder');
    expect(screen.getByText(/^Add a description\./)).toBeInTheDocument();
    expect(screen.getByText('Save changes')).not.toBeDisabled();
  });
});
