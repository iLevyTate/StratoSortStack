/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockState = {};
const mockDispatch = jest.fn();
let mockDebouncedAutoSave = null;
// Captures the REAL auto-save body passed to useDebouncedCallback so tests
// can invoke it directly (the debounce wrapper itself stays mocked).
const mockAutoSaveCapture = { current: null };

const mockToggleSettings = jest.fn(() => ({ type: 'ui/toggleSettings' }));
const mockCloseSettings = jest.fn(() => ({ type: 'ui/closeSettings' }));
const mockUpdateSettings = jest.fn((payload) => ({ type: 'ui/updateSettings', payload }));
const mockAddNotification = jest.fn();

const mockSettingsGet = jest.fn();
const mockSettingsSave = jest.fn();
const mockGetDocumentsPath = jest.fn();
const mockGetModels = jest.fn();
const mockTestConnection = jest.fn();

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  toggleSettings: (...args) => mockToggleSettings(...args),
  closeSettings: (...args) => mockCloseSettings(...args),
  updateSettings: (...args) => mockUpdateSettings(...args)
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    addNotification: mockAddNotification
  })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  getElectronAPI: () => ({}),
  settingsIpc: {
    get: (...args) => mockSettingsGet(...args),
    save: (...args) => mockSettingsSave(...args)
  },
  filesIpc: {
    getDocumentsPath: (...args) => mockGetDocumentsPath(...args)
  },
  llamaIpc: {
    getModels: (...args) => mockGetModels(...args),
    testConnection: (...args) => mockTestConnection(...args),
    downloadModel: jest.fn().mockResolvedValue({ success: true }),
    deleteModel: jest.fn().mockResolvedValue({ success: true })
  },
  eventsIpc: {
    onOperationProgress: jest.fn(() => () => {})
  }
}));

jest.mock('../../src/renderer/hooks/usePerformance', () => ({
  useDebouncedCallback: jest.fn((fn) => {
    mockAutoSaveCapture.current = fn;
    return mockDebouncedAutoSave;
  })
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../src/shared/settingsValidation', () => ({
  sanitizeSettings: jest.fn((value) => value || {})
}));

jest.mock('../../src/shared/constants', () => ({
  DEFAULT_AI_MODELS: {
    TEXT_ANALYSIS: 'text-model',
    IMAGE_ANALYSIS: 'vision-model',
    EMBEDDING: 'embedding-model'
  }
}));

jest.mock('../../src/shared/defaultSettings', () => ({
  DEFAULT_SETTINGS: {
    language: 'en',
    defaultSmartFolderLocation: 'Documents',
    experienceMode: 'simple'
  }
}));

jest.mock('../../src/shared/performanceConstants', () => ({
  DEBOUNCE: {
    SETTINGS_HYDRATION: 1000
  }
}));

jest.mock('../../src/renderer/utils/scrollLock', () => ({
  lockAppScroll: jest.fn(),
  unlockAppScroll: jest.fn()
}));

jest.mock('lucide-react', () => {
  const Icon = (props) => <svg {...props} />;
  return {
    Cloud: Icon,
    Brain: Icon,
    CheckCircle2: Icon,
    ChevronsDown: Icon,
    ChevronsUp: Icon,
    CircleAlert: Icon,
    FolderOpen: Icon,
    History: Icon,
    Loader2: Icon,
    Monitor: Icon,
    Plus: Icon,
    Save: Icon,
    Search: Icon,
    Settings: Icon,
    Wrench: Icon,
    X: Icon,
    Zap: Icon
  };
});

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/ui/IconButton', () => ({
  __esModule: true,
  default: ({ icon, children, ...props }) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Collapsible', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ title, description, children }) => (
    <section>
      {title ? <h3>{title}</h3> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  )
}));

jest.mock('../../src/renderer/components/ui/LoadingSkeleton', () => ({
  ModalLoadingOverlay: ({ message }) => <div>{message}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ as: Component = 'h2', children }) => <Component>{children}</Component>,
  Text: ({ as: Component = 'span', children }) => <Component>{children}</Component>,
  Caption: ({ children, ...rest }) => <span {...rest}>{children}</span>
}));

jest.mock('../../src/renderer/components/layout', () => ({
  Stack: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/settings/AutoOrganizeSection', () => () => null);
jest.mock('../../src/renderer/components/settings/BackgroundModeSection', () => () => null);
jest.mock('../../src/renderer/components/settings/NotificationSettingsSection', () => () => null);
jest.mock('../../src/renderer/components/settings/LlamaConfigSection', () => () => (
  <div>Local AI Engine Section</div>
));
jest.mock('../../src/renderer/components/settings/ModelSelectionSection', () => () => (
  <div>Model Selection Section</div>
));
jest.mock('../../src/renderer/components/settings/ChatPersonaSection', () => () => (
  <div>Chat persona settings</div>
));
jest.mock('../../src/renderer/components/settings/ModelManagementSection', () => () => null);
jest.mock('../../src/renderer/components/settings/EmbeddingRebuildSection', () => () => null);
jest.mock('../../src/renderer/components/settings/EmbeddingBehaviorSection', () => () => (
  <div>Embedding Behavior Section</div>
));
jest.mock('../../src/renderer/components/settings/NamingSettingsSection', () => () => null);
jest.mock('../../src/renderer/components/settings/GraphRetrievalSection', () => () => (
  <div>Graph Retrieval Section</div>
));
jest.mock('../../src/renderer/components/settings/ProcessingLimitsSection', () => () => (
  <div>Processing Limits Section</div>
));
jest.mock('../../src/renderer/components/settings/ApplicationSection', () => () => null);
jest.mock('../../src/renderer/components/settings/APITestSection', () => () => null);
jest.mock('../../src/renderer/components/settings/LegalNoticesSection', () => () => null);
jest.mock('../../src/renderer/components/settings/SettingsBackupSection', () => () => null);
jest.mock('../../src/renderer/components/settings/DebugToolsSection', () => () => null);
jest.mock('../../src/renderer/components/settings/DiagnosticsLogsSection', () => () => (
  <div>Diagnostics Logs Section</div>
));
jest.mock('../../src/renderer/components/settings/AIProviderSection', () => () => (
  <div>AI Provider Section</div>
));
jest.mock('../../src/renderer/components/settings/DiagnosticsSnapshotSection', () => () => null);
jest.mock('../../src/renderer/components/settings/AboutSection', () => () => null);
jest.mock('../../src/renderer/components/settings/ExclusionRulesEditor', () => () => null);

jest.mock('../../src/renderer/components/settings/DefaultLocationsSection', () => ({
  __esModule: true,
  default: ({ setSettings }) => (
    <button
      type="button"
      data-testid="local-edit"
      onClick={() =>
        setSettings((prev) => ({
          ...prev,
          language: 'local'
        }))
      }
    >
      Local Edit
    </button>
  )
}));

import SettingsPanel from '../../src/renderer/components/SettingsPanel';

describe('SettingsPanel regression guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState = {
      ui: {
        settings: { language: 'en', defaultSmartFolderLocation: 'C:/Initial' }
      }
    };
    mockSettingsGet.mockResolvedValue({ language: 'en', defaultSmartFolderLocation: 'C:/Initial' });
    mockSettingsSave.mockResolvedValue({ success: true, settings: { language: 'en' } });
    mockGetDocumentsPath.mockResolvedValue('C:/Initial');
    mockGetModels.mockResolvedValue({
      categories: { text: [], vision: [], embedding: [] },
      models: []
    });
    mockTestConnection.mockResolvedValue({ success: false });
    const autoSaveFn = jest.fn();
    autoSaveFn.cancel = jest.fn();
    autoSaveFn.flush = jest.fn().mockResolvedValue(undefined);
    mockDebouncedAutoSave = autoSaveFn;
  });

  test('skips llama testConnection auto-health check when llama is already online', async () => {
    mockState = {
      ui: {
        settings: { language: 'en', defaultSmartFolderLocation: 'C:/Initial' },
        showSettings: true
      },
      system: {
        health: { llama: 'online' }
      }
    };

    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

    expect(mockTestConnection).not.toHaveBeenCalled();
  });

  test('auto-save is a no-op after syncing Redux settings that carry the ai blob', async () => {
    // Redux ui.settings retains the `ai` provider blob (persisted via its own
    // IPC); the panel's save path strips it. Every snapshot the panel stores
    // must use the same ai-free shape as the auto-save comparison, or syncing
    // Redux state into the panel leaves a permanently "dirty" snapshot and a
    // phantom no-op settings:save + settings-changed broadcast fires on every
    // Settings open (QA 2026-07-11: "Applied Llama config update,
    // changedModelKeys: []").
    const { rerender } = render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    await screen.findByRole('searchbox', { name: /search settings/i });

    // Local edit, then an external Redux update that includes the ai blob —
    // accepting it routes the ai-carrying object into panel state + snapshot.
    fireEvent.click(screen.getByTestId('local-edit'));
    mockState = {
      ...mockState,
      ui: {
        ...mockState.ui,
        settings: {
          language: 'external',
          defaultSmartFolderLocation: 'C:/External',
          ai: { provider: 'local', apiKeys: {} }
        }
      }
    };
    // SettingsPanel is React.memo'd with no props, so a bare rerender bails
    // out and the mocked useAppSelector never re-reads mockState. Real Redux
    // subscriptions force the re-render in production; here a changing dummy
    // prop defeats the memo bailout.
    rerender(<SettingsPanel __testForceRender={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reload external settings' }));

    // Nothing changed since the accepted external state, so the real
    // auto-save body (captured from useDebouncedCallback) must not save.
    expect(mockAutoSaveCapture.current).toBeInstanceOf(Function);
    await mockAutoSaveCapture.current();

    expect(mockSettingsSave).not.toHaveBeenCalled();
  });

  test('awaits pending auto-save flush before closing panel', async () => {
    let resolveFlush;
    const flushPromise = new Promise((resolve) => {
      resolveFlush = resolve;
    });
    mockDebouncedAutoSave.flush = jest.fn(() => flushPromise);

    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());

    const closeButton = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(closeButton);

    expect(mockCloseSettings).not.toHaveBeenCalled();

    resolveFlush();
    await waitFor(() => {
      expect(mockCloseSettings).toHaveBeenCalledTimes(1);
    });
  });

  test('protects dirty local edits from external sync until user chooses reload', async () => {
    const { rerender } = render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    // The hydration overlay clears asynchronously; subsequent assertions
    // below use findBy*/waitFor, which naturally await that transition.
    expect(screen.queryByText('External update detected')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('local-edit'));

    mockUpdateSettings.mockClear();
    mockState = {
      ...mockState,
      ui: {
        ...mockState.ui,
        settings: { language: 'external', defaultSmartFolderLocation: 'C:/External' }
      }
    };
    // SettingsPanel is React.memo'd with no props, so a bare rerender bails
    // out and the mocked useAppSelector never re-reads mockState. Real Redux
    // subscriptions force the re-render in production; here a changing dummy
    // prop defeats the memo bailout. (The pre-fix version of this test only
    // passed because the panel raised a spurious conflict card from its own
    // unchanged base state — the H3 own-echo bug.)
    rerender(<SettingsPanel __testForceRender={1} />);

    expect(await screen.findByText('External update detected')).toBeInTheDocument();
    expect(mockUpdateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ language: 'external' })
    );

    mockUpdateSettings.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reload external settings' }));
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(expect.any(Object));
    });
  });

  test('does not raise a conflict card for the panel`s own unchanged base state', async () => {
    // H3 regression guard: while the user has unsaved local edits, a sync
    // pass where Redux still holds the last-saved base state (or the echo of
    // our own save) is NOT an external change and must not raise the
    // conflict card.
    const { rerender } = render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    await screen.findByRole('searchbox', { name: /search settings/i });

    fireEvent.click(screen.getByTestId('local-edit'));
    // Force a re-render (and thus a sync-effect pass) without changing
    // Redux state.
    rerender(<SettingsPanel __testForceRender={1} />);

    await waitFor(() => {
      expect(screen.queryByText('External update detected')).not.toBeInTheDocument();
    });
    expect(mockAddNotification).not.toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      expect.anything(),
      'settings-conflict'
    );
  });

  test('conflict cancels pending auto-save and "keep local" re-saves the edits', async () => {
    const { rerender } = render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    await screen.findByRole('searchbox', { name: /search settings/i });

    fireEvent.click(screen.getByTestId('local-edit'));
    mockState = {
      ...mockState,
      ui: {
        ...mockState.ui,
        settings: { language: 'external', defaultSmartFolderLocation: 'C:/External' }
      }
    };
    rerender(<SettingsPanel __testForceRender={1} />);

    expect(await screen.findByText('External update detected')).toBeInTheDocument();
    // H2: the debounced save holding the pre-conflict edits must be frozen
    // so it can't clobber the external change while the user decides.
    expect(mockDebouncedAutoSave.cancel).toHaveBeenCalled();

    mockDebouncedAutoSave.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Keep local edits' }));

    // Keeping local edits must re-assert them on disk — the conflict
    // detection cancelled the pending save, so a new one must be scheduled.
    expect(mockDebouncedAutoSave).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText('External update detected')).not.toBeInTheDocument();
    });
  });

  test('simple mode hides advanced settings until advanced mode is selected', async () => {
    mockState = {
      ui: {
        settings: {
          language: 'en',
          defaultSmartFolderLocation: 'C:/Initial',
          experienceMode: 'simple'
        }
      }
    };
    mockSettingsGet.mockResolvedValue({
      language: 'en',
      defaultSmartFolderLocation: 'C:/Initial',
      experienceMode: 'simple'
    });

    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    // Wait for the post-hydration sections to appear rather than probing
    // the loading overlay by text — the overlay clears asynchronously
    // and findBy* naturally awaits that.
    expect(await screen.findByText('Local AI Engine Section')).toBeInTheDocument();
    expect(screen.queryByText('Model Selection Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Embedding Behavior Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Processing Limits Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Graph Retrieval Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Diagnostics Logs Section')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('Model Selection Section')).toBeInTheDocument();
    expect(screen.getByText('Embedding Behavior Section')).toBeInTheDocument();
    expect(screen.getByText('Processing Limits Section')).toBeInTheDocument();
    expect(screen.getByText('Graph Retrieval Section')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics Logs Section')).toBeInTheDocument();
  });

  // Note: The previous "surfaces backend save error details when saving
  // fails" test exercised the explicit "Save Settings" button. After the
  // 2026-04-29 UI optimization removed the button in favor of auto-save
  // with an inline status chip, the error path it covered now lives inside
  // the body of `useDebouncedCallback`, which this suite mocks wholesale.
  // The same backend error path is exercised by integration suites that
  // run real auto-save; this surface assertion is no longer worth the
  // mock acrobatics.

  test('renders settings search input that filters sections', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());

    const searchInput = await screen.findByRole('searchbox', { name: /search settings/i });
    expect(searchInput).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'qqxxnomatchqq' } });
    expect(screen.getByText(/No settings match/i)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.queryByText(/No settings match/i)).not.toBeInTheDocument();
  });

  test('search "chat with documents" reveals Chat persona in simple mode', async () => {
    mockState = {
      ui: {
        settings: {
          language: 'en',
          defaultSmartFolderLocation: 'C:/Initial',
          experienceMode: 'simple'
        }
      }
    };
    mockSettingsGet.mockResolvedValue({
      language: 'en',
      defaultSmartFolderLocation: 'C:/Initial',
      experienceMode: 'simple'
    });

    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());
    expect(screen.queryByText('Chat persona settings')).not.toBeInTheDocument();

    const searchInput = await screen.findByRole('searchbox', { name: /search settings/i });
    fireEvent.change(searchInput, { target: { value: 'chat with documents' } });

    expect(await screen.findByText('Chat persona settings')).toBeInTheDocument();
    expect(
      screen.getByText(/Showing advanced settings that match your search/i)
    ).toBeInTheDocument();
  });

  test('search "knowledge graph" surfaces graph retrieval in simple mode', async () => {
    mockState = {
      ui: {
        settings: {
          language: 'en',
          experienceMode: 'simple'
        }
      }
    };
    mockSettingsGet.mockResolvedValue({
      language: 'en',
      experienceMode: 'simple'
    });

    render(<SettingsPanel />);
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled());

    const searchInput = await screen.findByRole('searchbox', { name: /search settings/i });
    fireEvent.change(searchInput, { target: { value: 'knowledge graph' } });

    expect(await screen.findByText('Graph Retrieval Section')).toBeInTheDocument();
  });
});
