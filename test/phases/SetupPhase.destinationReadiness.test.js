/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Main seeds an Uncategorized folder on every profile and refuses to delete
// it, so on a fresh install it is the only entry smartFoldersIpc.get returns.
// Welcome does not count it as a destination ("Add at least one smart folder
// first"); Setup has to agree, or the user is told to add a folder and then
// shown "Ready for discovery" for the same list.

const mockDispatch = jest.fn();
const mockNotificationApi = {
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showWarning: jest.fn(),
  showInfo: jest.fn(),
  addNotification: jest.fn()
};

const UNCATEGORIZED = {
  id: 'default-uncategorized',
  name: 'Uncategorized',
  category: 'uncategorized',
  isDefault: true,
  path: 'C:/Users/me/Documents/Uncategorized',
  physicallyExists: true
};
const RECEIPTS = {
  id: 'folder-1',
  name: 'Receipts',
  path: 'C:/Users/me/Documents/Receipts',
  physicallyExists: true
};

let mockFolders = [UNCATEGORIZED];

const storeState = {
  system: {
    documentsPath: 'C:/Users/me/Documents',
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
  MinimizableGuideCard: ({ children, collapsedSummary }) => (
    <div>
      <div data-testid="guide-summary">{collapsedSummary}</div>
      {children}
    </div>
  ),
  StateMessage: ({ title }) => <div>{title}</div>,
  StatusBadge: ({ children }) => <div data-testid="status-badge">{children}</div>
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

jest.mock('../../src/renderer/components/setup', () => ({
  SmartFolderItem: ({ folder }) => <div data-testid="folder-item">{folder?.name}</div>,
  AddSmartFolderModal: () => null
}));

import SetupPhase from '../../src/renderer/phases/SetupPhase';

async function renderLoaded() {
  render(<SetupPhase />);
  await screen.findAllByTestId('folder-item');
  const continueButton = await screen.findByRole('button', { name: 'Continue to Discovery' });
  return continueButton;
}

function badgeTexts() {
  return screen.getAllByTestId('status-badge').map((el) => el.textContent);
}

describe('SetupPhase destination readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFolders = [UNCATEGORIZED];
  });

  test('the Uncategorized fallback alone does not count as a destination', async () => {
    const continueButton = await renderLoaded();

    expect(badgeTexts()).toContain('No destination yet');
    expect(badgeTexts()).not.toContain('Ready for discovery');
    // Continue stays enabled here, so no copy may claim a destination is
    // required to continue (onboarding-ux-2 review).
    expect(badgeTexts()).not.toContain('Add at least one destination');
    expect(screen.queryByText(/destination to continue/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/1 destination ready/)).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for your first destination')).toBeInTheDocument();
    // Continue still works (Discover analyzes and searches without a
    // destination), and it says where files would end up in visible text
    // tied to the button, not only in a hover tooltip.
    expect(continueButton).not.toBeDisabled();
    const note = screen.getByText(/only go to Uncategorized/i, { selector: '[id]' });
    expect(continueButton.getAttribute('aria-describedby')).toBe(note.id);
  });

  test('one real folder next to Uncategorized is ready, and counts as one destination', async () => {
    mockFolders = [UNCATEGORIZED, RECEIPTS];
    const continueButton = await renderLoaded();

    expect(badgeTexts()).toContain('Ready for discovery');
    expect(screen.getByText('1 destination ready')).toBeInTheDocument();
    expect(continueButton).not.toBeDisabled();
    expect(screen.queryByText(/only go to Uncategorized/i)).not.toBeInTheDocument();
    expect(continueButton.getAttribute('aria-describedby')).toBeNull();

    await act(async () => {
      fireEvent.click(continueButton);
    });
    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setPhase', payload: 'discover' })
      )
    );
    expect(mockNotificationApi.showWarning).not.toHaveBeenCalled();
  });
});
