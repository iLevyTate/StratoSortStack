/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelSetupWizard from '../../src/renderer/components/ModelSetupWizard';
import { INSTALL_MODEL_PROFILES } from '../../src/shared/constants';

jest.mock('../../src/renderer/components/ui/AlertBox', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/ui/Card', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/SelectionCard', () => ({
  __esModule: true,
  // `selected` is surfaced as a data attribute: React drops an unknown
  // boolean attribute on <button>, so tests could not see the selection.
  default: ({ children, onSelect, selected, ...props }) => (
    <button onClick={onSelect} data-selected={selected ? 'true' : 'false'} {...props}>
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  ConfirmModal: ({ isOpen, title, message, onConfirm, onClose, confirmText, cancelText }) =>
    isOpen ? (
      <div role="dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onClose}>{cancelText}</button>
      </div>
    ) : null
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  __esModule: true,
  Text: ({ children, ...props }) => <span {...props}>{children}</span>,
  Heading: ({ children }) => <h2>{children}</h2>,
  Caption: ({ children, ...props }) => <span {...props}>{children}</span>
}));

describe('ModelSetupWizard', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete window.electronAPI;
  });

  test('times out stuck system checks and falls back to manual setup', async () => {
    jest.useFakeTimers();

    window.electronAPI = {
      llama: {
        getConfig: jest.fn(() => new Promise(() => {})),
        getModels: jest.fn(() => new Promise(() => {})),
        getDownloadStatus: jest.fn(() => new Promise(() => {}))
      }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    expect(screen.getByText(/Preparing AI Setup/i)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(12050);
    });

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        /AI check is taking longer than expected\. You can continue with manual setup/i
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Download Models/i)).toBeInTheDocument();
    expect(screen.getByText(/Continue with limited AI/i)).toBeInTheDocument();
  });

  test('times out stuck checks under StrictMode', async () => {
    jest.useFakeTimers();

    window.electronAPI = {
      llama: {
        getConfig: jest.fn(() => new Promise(() => {})),
        getModels: jest.fn(() => new Promise(() => {})),
        getDownloadStatus: jest.fn(() => new Promise(() => {}))
      }
    };

    render(
      <React.StrictMode>
        <ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />
      </React.StrictMode>
    );

    expect(screen.getByText(/Preparing AI Setup/i)).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(12050);
    });

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
  });

  test('reacts to download completion/error progress events', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    let progressListener;
    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          embeddingModel,
          textModel,
          visionModel
        })),
        getModels: jest.fn(async () => ({ models: [] })),
        getDownloadStatus: jest.fn(async () => ({
          status: {
            downloads: [
              { filename: embeddingModel, progress: 10 },
              { filename: textModel, progress: 10 },
              { filename: visionModel, progress: 10 }
            ]
          }
        })),
        downloadModel: jest.fn(async () => ({ success: true, started: true }))
      },
      events: {
        onOperationProgress: jest.fn((cb) => {
          progressListener = cb;
          return jest.fn();
        })
      }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Download Models/i }));
    await waitFor(() => {
      expect(screen.getByText(/Downloading Models/i)).toBeInTheDocument();
    });

    await act(async () => {
      progressListener({ type: 'model-download-error', model: textModel, error: 'network' });
    });
    await waitFor(() => {
      expect(screen.getByText(/Retry Failed Downloads/i)).toBeInTheDocument();
    });

    await act(async () => {
      progressListener({ type: 'model-download-complete', model: embeddingModel });
      progressListener({ type: 'model-download-complete', model: textModel });
      progressListener({ type: 'model-download-complete', model: visionModel });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Continue$/i })).toBeInTheDocument();
    });
  });

  test('renders a cancelled download and keeps it cancelled after the abort error (M9)', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    let progressListener;
    const cancelDownload = jest.fn(async () => ({ success: true }));
    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({ embeddingModel, textModel, visionModel })),
        getModels: jest.fn(async () => ({ models: [] })),
        getDownloadStatus: jest.fn(async () => ({
          status: {
            downloads: [
              { filename: embeddingModel, progress: 10 },
              { filename: textModel, progress: 10 },
              { filename: visionModel, progress: 10 }
            ]
          }
        })),
        downloadModel: jest.fn(async () => ({ success: true, started: true })),
        cancelDownload
      },
      events: {
        onOperationProgress: jest.fn((cb) => {
          progressListener = cb;
          return jest.fn();
        })
      }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Download Models/i }));
    await waitFor(() => {
      expect(screen.getByText(/Downloading Models/i)).toBeInTheDocument();
    });

    await act(async () => {
      progressListener({ type: 'model-download', model: textModel, percent: 40 });
    });
    const cancelButtons = await screen.findAllByRole('button', { name: /Cancel download of/i });
    await act(async () => {
      fireEvent.click(cancelButtons[0]);
    });

    expect(cancelDownload).toHaveBeenCalledTimes(1);
    const [cancelledModel] = cancelDownload.mock.calls[0];
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.getByText('Download cancelled')).toBeInTheDocument();
    });
    expect(screen.getByText(/Retry Failed Downloads/i)).toBeInTheDocument();

    await act(async () => {
      progressListener({
        type: 'model-download-error',
        model: cancelledModel,
        error: 'The operation was aborted'
      });
    });

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByText('The operation was aborted')).not.toBeInTheDocument();
  });

  test('asks about an embedding switch during the system check, and the check does not time out while asking', async () => {
    jest.useFakeTimers();
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;
    const updateConfig = jest.fn(async () => ({ success: true }));
    const getStats = jest.fn(async () => ({ files: 12 }));

    window.electronAPI = {
      llama: {
        // The engine runs an older embedding model; the recommended profile
        // uses another and every model it needs is already installed.
        getConfig: jest.fn(async () => ({
          embeddingModel: 'old-embed.gguf',
          textModel,
          visionModel
        })),
        getModels: jest.fn(async () => ({
          models: [embeddingModel, textModel, visionModel, 'old-embed.gguf'],
          selected: { embeddingModel, textModel, visionModel }
        })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig
      },
      embeddings: { getStats },
      events: { onOperationProgress: jest.fn(() => jest.fn()) }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('12 files embedded with "old-embed.gguf"');
    expect(updateConfig).not.toHaveBeenCalled();

    // The 15 s "check timed out" failsafe must not fire over an open question.
    await act(async () => {
      jest.advanceTimersByTime(16000);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/AI system check timed out/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch and rebuild' }));
    await waitFor(() => {
      expect(screen.getByText(/Setup complete/i)).toBeInTheDocument();
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(getStats).toHaveBeenCalledTimes(1);
  });

  test('keeping the current model during the check returns to model selection without applying', async () => {
    jest.useFakeTimers();
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;
    const updateConfig = jest.fn(async () => ({ success: true }));

    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          embeddingModel: 'old-embed.gguf',
          textModel,
          visionModel
        })),
        getModels: jest.fn(async () => ({
          models: [embeddingModel, textModel, visionModel, 'old-embed.gguf'],
          selected: { embeddingModel, textModel, visionModel }
        })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig
      },
      embeddings: { getStats: jest.fn(async () => ({ files: 3 })) },
      events: { onOperationProgress: jest.fn(() => jest.fn()) }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep current model' }));

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('uses nested getConfig payload when checking missing required models', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          success: true,
          config: {
            embeddingModel: 'custom-embed.gguf',
            textModel: 'custom-text.gguf',
            visionModel
          }
        })),
        getModels: jest.fn(async () => ({ models: [embeddingModel, textModel] })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } }))
      },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText('Size unavailable').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/At least /i)).toBeInTheDocument();
  });

  test('does not skip to completion when the selected vision model is still missing', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    const getConfig = jest.fn(async () => ({
      embeddingModel,
      textModel,
      visionModel
    }));
    const getModels = jest.fn(async () => ({
      models: [embeddingModel, textModel],
      selected: {
        embeddingModel,
        textModel,
        visionModel
      }
    }));

    window.electronAPI = {
      llama: {
        getConfig,
        getModels,
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } }))
      },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getConfig).toHaveBeenCalled();
      expect(getModels).toHaveBeenCalled();
    });

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: /Download Models/i })).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    expect(screen.queryByRole('button', { name: /Get Started/i })).not.toBeInTheDocument();
  });

  test('asks before switching the embedding model when files are already indexed', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const qualityProfile = INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.models || {};
    const currentEmbedding = baseProfile.EMBEDDING;
    const nextEmbedding = qualityProfile.EMBEDDING;
    expect(nextEmbedding).not.toBe(currentEmbedding);

    const updateConfig = jest.fn(async () => ({ success: true }));
    const getStats = jest.fn(async () => ({ success: true, files: 12, chunks: 300 }));
    window.electronAPI = {
      llama: {
        // Base is configured but its text model is not on disk, so the
        // wizard stops on the Choose step instead of auto-completing.
        getConfig: jest.fn(async () => ({
          embeddingModel: currentEmbedding,
          textModel: baseProfile.TEXT_ANALYSIS,
          visionModel: baseProfile.IMAGE_ANALYSIS
        })),
        getModels: jest.fn(async () => ({
          models: [
            currentEmbedding,
            qualityProfile.EMBEDDING,
            qualityProfile.TEXT_ANALYSIS,
            qualityProfile.IMAGE_ANALYSIS
          ]
        })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig
      },
      embeddings: { getStats },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    // Drive the async chains inside act: a preceding test's purged timers can
    // leave React's host scheduler unable to flush outside-act updates.
    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Better Quality/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download models/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/Switch embedding model and rebuild the index\?/);
    expect(dialog).toHaveTextContent(`12 files embedded with "${currentEmbedding}"`);
    expect(dialog).toHaveTextContent(`Switching to "${nextEmbedding}"`);
    expect(getStats).toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();

    // Declining keeps the current model and stays on the Choose step.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep current model/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();

    // Accepting applies the profile.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download models/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Switch and rebuild/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: nextEmbedding })
    );
  });

  test('switches the embedding model without asking when nothing is indexed yet', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const qualityProfile = INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.models || {};

    const updateConfig = jest.fn(async () => ({ success: true }));
    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          embeddingModel: baseProfile.EMBEDDING,
          textModel: baseProfile.TEXT_ANALYSIS,
          visionModel: baseProfile.IMAGE_ANALYSIS
        })),
        getModels: jest.fn(async () => ({
          models: [
            baseProfile.EMBEDDING,
            qualityProfile.EMBEDDING,
            qualityProfile.TEXT_ANALYSIS,
            qualityProfile.IMAGE_ANALYSIS
          ]
        })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig
      },
      embeddings: { getStats: jest.fn(async () => ({ success: true, files: 0 })) },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Better Quality/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download models/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: qualityProfile.EMBEDDING })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('applies profile config before completing when all models pre-exist', async () => {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    const updateConfig = jest.fn(async () => ({ success: true }));
    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          embeddingModel,
          textModel,
          visionModel
        })),
        getModels: jest.fn(async () => ({
          models: [embeddingModel, textModel, visionModel],
          selected: { embeddingModel, textModel, visionModel }
        })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig
      },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    const steps = [];
    // Drive the whole checkSystem async chain inside act so the resulting
    // state updates land in the act queue (the global afterEach timer purge
    // can leave the host scheduler unable to flush outside-act updates).
    await act(async () => {
      render(
        <ModelSetupWizard
          onComplete={jest.fn()}
          onSkip={jest.fn()}
          onStepChange={(s) => steps.push(s)}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        textModel,
        embeddingModel,
        visionModel
      })
    );
    expect(steps).toContain('complete');
  });

  test('does not mark downloads complete when backend only reports started', async () => {
    jest.useFakeTimers();
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    const embeddingModel = baseProfile.EMBEDDING;
    const textModel = baseProfile.TEXT_ANALYSIS;
    const visionModel = baseProfile.IMAGE_ANALYSIS;

    const getDownloadStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: { downloads: [] } })
      .mockResolvedValueOnce({
        status: {
          downloads: [
            { filename: embeddingModel, progress: 1 },
            { filename: textModel, progress: 1 }
          ]
        }
      });

    window.electronAPI = {
      llama: {
        getConfig: jest.fn(async () => ({
          success: true,
          config: {
            embeddingModel,
            textModel,
            visionModel
          }
        })),
        getModels: jest
          .fn()
          .mockResolvedValueOnce({ models: [] })
          .mockResolvedValueOnce({ models: [] }),
        getDownloadStatus,
        downloadModel: jest.fn(async () => ({ success: true, started: true }))
      },
      events: {
        onOperationProgress: jest.fn(() => jest.fn())
      }
    };

    render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);

    await act(async () => {
      jest.advanceTimersByTime(7100);
    });

    const manualSetupButton = screen.queryByRole('button', { name: /Open manual setup/i });
    if (manualSetupButton) {
      fireEvent.click(manualSetupButton);
    }

    await act(async () => {
      // Ensure any pending timeout-driven fallback can resolve to the select step.
      jest.advanceTimersByTime(12050);
    });
    expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Download Models/i }));

    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    expect(screen.getByText(/Downloading Models/i)).toBeInTheDocument();
    expect(screen.queryByText(/Setup complete/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with limited AI/i })).toBeInTheDocument();
  });
});

describe('ModelSetupWizard hardware-aware profile (ML-07)', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  function freshInstallApi(hardware) {
    const baseProfile = INSTALL_MODEL_PROFILES?.BASE_SMALL?.models || {};
    return {
      llama: {
        getConfig: jest.fn(async () => ({
          embeddingModel: baseProfile.EMBEDDING,
          textModel: baseProfile.TEXT_ANALYSIS,
          visionModel: baseProfile.IMAGE_ANALYSIS
        })),
        getModels: jest.fn(async () => ({ models: [], selected: {} })),
        getDownloadStatus: jest.fn(async () => ({ status: { downloads: [] } })),
        updateConfig: jest.fn(async () => ({ success: true }))
      },
      system: {
        getRecommendedConcurrency: jest.fn(async () => hardware)
      },
      events: { onOperationProgress: jest.fn(() => jest.fn()) }
    };
  }

  test('a 32 GB machine with a 12 GB GPU gets Better Quality preselected and explained', async () => {
    window.electronAPI = freshInstallApi({
      success: true,
      maxConcurrent: 2,
      totalMemGB: 32,
      vramMB: 12288,
      hasGpu: true,
      gpuName: 'NVIDIA GeForce RTX 4070'
    });

    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wizard-hardware-advice')).toHaveTextContent(
        '32 GB of RAM and NVIDIA GeForce RTX 4070 (12 GB): this computer can carry the larger models.'
      );
    });
    const badges = screen.getAllByText('Recommended for this computer');
    expect(badges).toHaveLength(1);
    // The quality card carries the badge and is the selected card.
    const qualityCard = badges[0].closest('button');
    expect(qualityCard).toHaveTextContent(/Better Quality/);
    expect(qualityCard).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText(/Base \(Small & Fast\)/).closest('button')).toHaveAttribute(
      'data-selected',
      'false'
    );
  });

  test('an 8 GB machine keeps Base and says why', async () => {
    window.electronAPI = freshInstallApi({
      success: true,
      maxConcurrent: 1,
      totalMemGB: 8,
      vramMB: 0,
      hasGpu: false,
      gpuName: null
    });

    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wizard-hardware-advice')).toHaveTextContent(
        '8 GB of RAM: the larger profile needs 16 GB or more.'
      );
    });
    const badge = screen.getByText('Recommended for this computer');
    const baseCard = badge.closest('button');
    expect(baseCard).toHaveTextContent(/Base/);
    expect(baseCard).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText(/Better Quality \(Larger\)/).closest('button')).toHaveAttribute(
      'data-selected',
      'false'
    );
  });

  test('a failed hardware probe leaves the wizard usable with no recommendation', async () => {
    window.electronAPI = freshInstallApi({ success: false, maxConcurrent: 1 });

    await act(async () => {
      render(<ModelSetupWizard onComplete={jest.fn()} onSkip={jest.fn()} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.getByText(/Choose AI Models/i)).toBeInTheDocument());
    expect(screen.queryByText('Recommended for this computer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wizard-hardware-advice')).not.toBeInTheDocument();
  });
});

describe('ModelSetupWizard timeout helper', () => {
  test('uses shared withTimeout rather than a local copy', () => {
    const fs = jest.requireActual('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/components/ModelSetupWizard.jsx'),
      'utf8'
    );
    expect(src).toMatch(/from ['"]\.\.\/\.\.\/shared\/promiseUtils['"]/);
    expect(src).not.toMatch(/function withTimeout\s*\(/);
  });
});
