/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
// Mutable store snapshot for useAppSelector (F-206: the Organize CTA reads
// the smart-folder list to decide whether Setup has to come first).
const mockState = { files: { smartFolders: [{ id: 'f1', name: 'Finance', path: 'C:\\Finance' }] } };
jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

const mockAddNotification = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: mockAddNotification }))
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  toggleSettings: jest.fn(() => ({ type: 'ui/toggleSettings' })),
  openSettings: jest.fn(() => ({ type: 'ui/openSettings' })),
  setPhase: jest.fn((phase) => ({ type: 'ui/setPhase', payload: phase })),
  setViewMode: jest.fn((mode) => ({ type: 'ui/setViewMode', payload: mode }))
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
  Card: ({ children, as, onClick, type }) =>
    as === 'button' ? (
      <button type={type || 'button'} data-testid="card" onClick={onClick}>
        {children}
      </button>
    ) : (
      <div data-testid="card">{children}</div>
    )
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children }) => <h1>{children}</h1>,
  Text: ({ children }) => <span>{children}</span>,
  Caption: ({ children }) => <small>{children}</small>
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div data-testid="modal">{children}</div> : null)
}));

jest.mock('../../src/renderer/components/layout', () => ({
  Stack: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ModelSetupWizard', () => ({
  __esModule: true,
  default: ({ onStepChange }) => (
    <div data-testid="model-setup-wizard">
      <button
        data-testid="wizard-start-download"
        onClick={() => (typeof onStepChange === 'function' ? onStepChange('downloading') : null)}
      >
        start download
      </button>
    </div>
  )
}));

jest.mock('lucide-react', () => ({
  Rocket: () => <span />,
  FolderOpen: () => <span />,
  Settings: () => <span />,
  Search: () => <span />,
  Sparkles: () => <span />,
  FolderCheck: () => <span />,
  Loader2: () => <span />,
  CheckCircle2: () => <span />,
  ListChecks: () => <span />,
  LayoutGrid: () => <span />,
  ArrowRight: () => <span />
}));

import WelcomePhase from '../../src/renderer/phases/WelcomePhase';

describe('WelcomePhase', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    mockAddNotification.mockReset();
    mockDispatch.mockReset();
    jest.useRealTimers();
    delete window.electronAPI;
    delete window.__STRATOSORT_FORCE_MODEL_WIZARD__;
    delete window.__STRATOSORT_DEBUG_MODE__;
    window.localStorage.removeItem('stratosort:debugMode');
    window.localStorage.removeItem('stratosort:forceModelWizard');
    window.history.replaceState({}, '', '/');
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('renders main content when Electron API is unavailable', async () => {
    window.electronAPI = undefined;
    render(<WelcomePhase />);

    await waitFor(
      () => {
        expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    expect(screen.queryByTestId('model-setup-wizard')).not.toBeInTheDocument();
  });

  test('renders main content when getModels is missing', async () => {
    window.electronAPI = { llama: {} };
    render(<WelcomePhase />);

    await waitFor(() => {
      expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('model-setup-wizard')).not.toBeInTheDocument();
  });

  test('keeps main welcome actions visible while model checks are still loading', async () => {
    window.electronAPI = {
      llama: {
        getModels: jest.fn(() => new Promise(() => {})),
        getConfig: jest.fn(() => new Promise(() => {})),
        getDownloadStatus: jest.fn(() =>
          Promise.resolve({ success: true, status: { downloads: [] } })
        )
      }
    };

    render(<WelcomePhase />);

    // The hero stays usable while the model check runs in the background.
    expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
    // Loading no longer renders an in-flow status card (it used to reflow the
    // centered layout taller); passive states surface as toasts instead.
    expect(screen.queryByText(/Verifying local models/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preparing local AI in the background/i)).not.toBeInTheDocument();
  });

  test('notifies and keeps actions usable when model checks hang', async () => {
    jest.useFakeTimers();
    window.electronAPI = {
      llama: {
        getModels: jest.fn(() => new Promise(() => {})),
        getConfig: jest.fn(() => new Promise(() => {})),
        getDownloadStatus: jest.fn(() =>
          Promise.resolve({ success: true, status: { downloads: [] } })
        )
      }
    };

    render(<WelcomePhase />);

    // No in-flow loading card — the hero remains the way forward.
    expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Preparing local AI in the background/i)).not.toBeInTheDocument();

    // Once the probe is slow enough to surface the escape, a transient toast is
    // fired instead of growing the layout with a card.
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.stringMatching(/Still preparing local AI/i),
      'info',
      expect.any(Number),
      'models-loading-slow'
    );
    expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
  });

  test('auto-opens model setup wizard when required models are missing', async () => {
    window.electronAPI = {
      llama: {
        getModels: jest.fn(async () => ({ models: ['unrelated.gguf'] })),
        getConfig: jest.fn(async () => ({
          success: true,
          config: {
            embeddingModel: 'embed-required.gguf',
            textModel: 'text-required.gguf'
          }
        })),
        getDownloadStatus: jest.fn(async () => ({
          success: true,
          status: {
            active: 1,
            downloads: [{ filename: 'embed-required.gguf', status: 'downloading' }]
          }
        }))
      }
    };

    render(<WelcomePhase />);

    await waitFor(
      () => {
        expect(screen.getByTestId('model-setup-wizard')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    // The wizard now opens inside the shared Modal, which overlays the
    // welcome content rather than replacing it.
    expect(screen.getByTestId('modal')).toBeInTheDocument();
  });

  test('auto-opens model setup wizard after retry when initial model list is empty', async () => {
    jest.useFakeTimers();
    const getModels = jest
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: ['unrelated.gguf'] });

    window.electronAPI = {
      llama: {
        getModels,
        getConfig: jest.fn(async () => ({
          success: true,
          config: {
            embeddingModel: 'embed-required.gguf',
            textModel: 'text-required.gguf'
          }
        })),
        getDownloadStatus: jest.fn(async () => ({
          success: true,
          status: { downloads: [] }
        }))
      }
    };

    render(<WelcomePhase />);

    await act(async () => {
      jest.advanceTimersByTime(1900);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('model-setup-wizard')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
    expect(getModels).toHaveBeenCalledTimes(2);
  });

  test('shows model setup wizard when dev force flag is enabled', async () => {
    process.env.NODE_ENV = 'development';
    window.history.replaceState({}, '', '/?forceModelWizard=1');
    window.electronAPI = undefined;

    render(<WelcomePhase />);

    await waitFor(() => {
      expect(screen.getByTestId('model-setup-wizard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('modal')).toBeInTheDocument();
  });

  test('uses corrected selected models from getModels when config contains stale names', async () => {
    window.electronAPI = {
      llama: {
        getModels: jest.fn(async () => ({
          models: ['embed-fixed.gguf', 'text-fixed.gguf'],
          selected: {
            embeddingModel: 'embed-fixed.gguf',
            textModel: 'text-fixed.gguf'
          }
        })),
        getConfig: jest.fn(async () => ({
          success: true,
          config: {
            embeddingModel: 'legacy-embed-name',
            textModel: 'legacy-text-name'
          }
        })),
        getDownloadStatus: jest.fn(async () => ({
          success: true,
          status: { downloads: [] }
        }))
      }
    };

    render(<WelcomePhase />);

    await waitFor(() => {
      expect(screen.getByText(/Organize files now/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Finish local AI setup when you are ready/i)).not.toBeInTheDocument();
  });

  describe('modelAutoDownloadSkipped persistence', () => {
    const missingModelsLlamaApi = () => ({
      getModels: jest.fn(async () => ({ models: ['unrelated.gguf'] })),
      getConfig: jest.fn(async () => ({
        success: true,
        config: {
          embeddingModel: 'embed-required.gguf',
          textModel: 'text-required.gguf'
        }
      })),
      getDownloadStatus: jest.fn(async () => ({
        success: true,
        status: { downloads: [] }
      }))
    });

    test('"Continue with limited AI" persists the skip setting', async () => {
      const update = jest.fn(async () => ({ success: true }));
      window.electronAPI = {
        llama: missingModelsLlamaApi(),
        settings: {
          get: jest.fn(async () => ({ modelAutoDownloadSkipped: false })),
          update
        }
      };

      render(<WelcomePhase />);
      // Flush the async model check deterministically (see note in the
      // wizard-download test below).
      await act(async () => {});
      await act(async () => {});

      const skipButton = await screen.findByText(
        /Continue with limited AI/i,
        {},
        { timeout: 3000 }
      );
      fireEvent.click(skipButton);

      await waitFor(() => {
        expect(update).toHaveBeenCalledWith('modelAutoDownloadSkipped', true);
      });
      // The setup card and wizard close for the session too.
      expect(screen.queryByTestId('model-setup-wizard')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Finish local AI setup when you are ready/i)
      ).not.toBeInTheDocument();
    });

    test('persisted skip suppresses the wizard auto-open and the setup card', async () => {
      window.electronAPI = {
        llama: missingModelsLlamaApi(),
        settings: {
          get: jest.fn(async () => ({ modelAutoDownloadSkipped: true })),
          update: jest.fn(async () => ({ success: true }))
        }
      };

      render(<WelcomePhase />);

      await screen.findByText(/Organize files now/i);
      // Give the async model check time to settle before asserting absence.
      await waitFor(() => {
        expect(window.electronAPI.settings.get).toHaveBeenCalled();
      });

      expect(screen.queryByTestId('model-setup-wizard')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Finish local AI setup when you are ready/i)
      ).not.toBeInTheDocument();
    });

    test('explicit wizard download clears the persisted skip', async () => {
      const update = jest.fn(async () => ({ success: true }));
      window.electronAPI = {
        llama: missingModelsLlamaApi(),
        settings: {
          get: jest.fn(async () => ({ modelAutoDownloadSkipped: false })),
          update
        }
      };

      render(<WelcomePhase />);
      // Flush the async model check (allSettled + download-status probe)
      // deterministically; findBy* alone can leave the resulting state
      // update parked in the act queue when prior tests ran async work.
      await act(async () => {});
      await act(async () => {});

      const startDownload = await screen.findByTestId(
        'wizard-start-download',
        {},
        { timeout: 3000 }
      );
      fireEvent.click(startDownload);

      await waitFor(() => {
        expect(update).toHaveBeenCalledWith('modelAutoDownloadSkipped', false);
      });
    });
  });

  test('guided chooser records the phased preference and enters Discover', async () => {
    window.electronAPI = undefined;
    render(<WelcomePhase />);

    await screen.findByText(/Organize files now/i);
    fireEvent.click(screen.getByText('Guided steps').closest('button'));

    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'phased' });
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
  });

  test('dashboard chooser records the preference but routes through Setup first', async () => {
    window.electronAPI = undefined;
    render(<WelcomePhase />);

    await screen.findByText(/Organize files now/i);
    fireEvent.click(screen.getByText('Dashboard').closest('button'));

    // The dashboard is empty until a smart folder exists, so the first-run
    // choice records the preference and sends the user to Setup; App.js swaps to
    // the dashboard once a folder lands.
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'dashboard' });
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'setup' });
  });

  // F-206 (CP-21): "Organize files now" used to jump straight to Discover.
  // With no smart folders every file resolves to defaultLocation/Uncategorized
  // — a first-run user "organizes" into one dump folder. Setup must come first.
  describe('Organize CTA with no smart folders [F-206]', () => {
    const originalFolders = mockState.files.smartFolders;
    afterEach(() => {
      mockState.files.smartFolders = originalFolders;
    });

    async function renderReady() {
      window.electronAPI = undefined;
      render(<WelcomePhase />);
      await waitFor(() => expect(screen.getByText(/Organize files now/i)).toBeInTheDocument(), {
        timeout: 3000
      });
    }

    test('routes to Setup and explains why when there are no smart folders', async () => {
      mockState.files.smartFolders = [];
      await renderReady();
      mockDispatch.mockClear();

      fireEvent.click(screen.getByText(/Organize files now/i));

      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'setup' });
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.stringMatching(/smart folder/i),
        expect.any(String),
        expect.anything(),
        expect.anything()
      );
    });

    test('a default-only folder list (just Uncategorized) still counts as none', async () => {
      mockState.files.smartFolders = [
        { id: 'default-uncategorized', name: 'Uncategorized', isDefault: true, path: 'C:\\U' }
      ];
      await renderReady();
      mockDispatch.mockClear();
      fireEvent.click(screen.getByText(/Organize files now/i));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'setup' });
    });

    test('goes to Discover as before once a real smart folder exists', async () => {
      await renderReady();
      mockDispatch.mockClear();
      fireEvent.click(screen.getByText(/Organize files now/i));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
    });

    // "Reset to Defaults" creates Documents, Images, ... Archives plus
    // Uncategorized, every one isDefault. They are real destinations; the old
    // `!isDefault` check sent these users back to Setup forever.
    test('the built-in default folders count as real destinations', async () => {
      mockState.files.smartFolders = [
        { id: 'default-documents-1', name: 'Documents', isDefault: true, path: 'C:\\D' },
        {
          id: 'default-uncategorized-1',
          name: 'Uncategorized',
          category: 'uncategorized',
          isDefault: true,
          path: 'C:\\U'
        }
      ];
      await renderReady();
      mockDispatch.mockClear();
      fireEvent.click(screen.getByText(/Organize files now/i));
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
    });
  });
});
