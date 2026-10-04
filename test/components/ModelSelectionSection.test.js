/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Select', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <select {...props}>{children}</select>
}));
jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div>{children}</div> : null)
}));
jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));
jest.mock('../../src/renderer/components/ui/StatusBadge', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/ui/StateMessage', () => ({
  __esModule: true,
  default: ({ title }) => <div>{title}</div>
}));
jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));
jest.mock('../../src/shared/logger', () => ({
  logger: { error: jest.fn() }
}));
jest.mock('../../src/shared/modelRegistry', () => ({
  getModel: jest.fn(() => ({ dimensions: 768 }))
}));

import ModelSelectionSection from '../../src/renderer/components/settings/ModelSelectionSection';

describe('ModelSelectionSection', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  // Contract: "Change & rebuild now" commits the model selection immediately
  // (so it can never desync from a rebuild that outlives the IPC timeout) and
  // reports the rebuild outcome via an inline status alert. Failures keep the
  // selection and tell the user to rebuild from AI Configuration.

  const renderWithModels = (setSettings) =>
    render(
      <ModelSelectionSection
        settings={{ textModel: 't.gguf', visionModel: 'v.gguf', embeddingModel: 'old.gguf' }}
        setSettings={setSettings}
        textModelOptions={['t.gguf']}
        visionModelOptions={['v.gguf']}
        embeddingModelOptions={['old.gguf', 'new.gguf']}
      />
    );

  const changeAndRebuild = () => {
    const embeddingSelect = screen.getAllByRole('combobox')[2];
    fireEvent.change(embeddingSelect, { target: { value: 'new.gguf' } });
    fireEvent.click(screen.getByRole('button', { name: /change & rebuild now/i }));
  };

  const expectModelCommitted = (setSettings) => {
    const updater = setSettings.mock.calls.find(([arg]) => typeof arg === 'function')?.[0];
    expect(updater).toBeInstanceOf(Function);
    expect(updater({ embeddingModel: 'old.gguf' })).toMatchObject({
      embeddingModel: 'new.gguf'
    });
  };

  test('commits model immediately and shows success alert when rebuild succeeds', async () => {
    const setSettings = jest.fn();
    window.electronAPI = {
      embeddings: {
        getStats: jest.fn().mockResolvedValue({ totalDocuments: 10 }),
        fullRebuild: jest.fn().mockResolvedValue({ success: true })
      }
    };

    renderWithModels(setSettings);
    changeAndRebuild();

    await waitFor(() => {
      expect(window.electronAPI.embeddings.fullRebuild).toHaveBeenCalledWith({
        modelOverride: 'new.gguf'
      });
    });
    expectModelCommitted(setSettings);
    await waitFor(() => {
      expect(screen.getByText(/embeddings rebuilt with new\.gguf/i)).toBeInTheDocument();
    });
  });

  test('keeps committed model and surfaces failure alert when rebuild rejects', async () => {
    const setSettings = jest.fn();
    window.electronAPI = {
      embeddings: {
        getStats: jest.fn().mockResolvedValue({ totalDocuments: 10 }),
        fullRebuild: jest.fn().mockRejectedValue(new Error('rebuild failed'))
      }
    };

    renderWithModels(setSettings);
    changeAndRebuild();

    await waitFor(() => {
      expect(window.electronAPI.embeddings.fullRebuild).toHaveBeenCalledWith({
        modelOverride: 'new.gguf'
      });
    });
    expectModelCommitted(setSettings);
    await waitFor(() => {
      expect(screen.getByText(/embeddings rebuild failed/i)).toBeInTheDocument();
    });
  });

  test('surfaces structured failure message from rebuild response', async () => {
    const setSettings = jest.fn();
    window.electronAPI = {
      embeddings: {
        getStats: jest.fn().mockResolvedValue({ totalDocuments: 10 }),
        fullRebuild: jest.fn().mockResolvedValue({
          success: false,
          error: 'Model unavailable'
        })
      }
    };

    renderWithModels(setSettings);
    changeAndRebuild();

    await waitFor(() => {
      expect(window.electronAPI.embeddings.fullRebuild).toHaveBeenCalledWith({
        modelOverride: 'new.gguf'
      });
    });
    expectModelCommitted(setSettings);
    await waitFor(() => {
      expect(screen.getByText(/model unavailable/i)).toBeInTheDocument();
    });
  });

  test('treats response lacking success=true as a failure', async () => {
    const setSettings = jest.fn();
    window.electronAPI = {
      embeddings: {
        getStats: jest.fn().mockResolvedValue({ totalDocuments: 10 }),
        fullRebuild: jest.fn().mockResolvedValue({ model: 'new.gguf' })
      }
    };

    renderWithModels(setSettings);
    changeAndRebuild();

    await waitFor(() => {
      expect(window.electronAPI.embeddings.fullRebuild).toHaveBeenCalledWith({
        modelOverride: 'new.gguf'
      });
    });
    expectModelCommitted(setSettings);
    await waitFor(() => {
      expect(screen.getByText(/embeddings rebuild failed/i)).toBeInTheDocument();
    });
  });
});
