/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ title, description, children }) => (
    <div data-testid="settings-card">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  )
}));

jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ label, children }) => (
    <div data-testid="setting-row">
      {label && <label>{label}</label>}
      {children}
    </div>
  )
}));

import aiProviderReducer from '../../src/renderer/store/slices/aiProviderSlice';
import AIProviderSection from '../../src/renderer/components/settings/AIProviderSection';
import { CLOUD_AI_CONSENT_FLAG } from '../../src/renderer/components/common/CloudAIConsentModal';

beforeEach(() => {
  window.localStorage.clear();
  global.window.electronAPI = {
    aiProvider: {
      getConfig: jest.fn(async () => ({
        success: true,
        settings: {
          providers: { local: { enabled: true } },
          routing: { default: 'local', perFolder: {} }
        },
        status: {
          providers: [{ id: 'local', enabled: true, ready: true }],
          routing: { default: 'local', perFolder: {} }
        }
      })),
      getKeyStatus: jest.fn(async () => ({ success: true, hasKey: false, lastFour: null })),
      setRouting: jest.fn(async () => ({
        success: true,
        status: { providers: [], routing: { default: 'anthropic', perFolder: {} } }
      })),
      // CloudAIConsentModal now talks to main process to record consent.
      // Without this mock, the consent flow rejects and onAccept is never called.
      acknowledgeCloud: jest.fn(async () => ({
        success: true,
        status: {
          providers: [],
          routing: { default: 'local', perFolder: {} },
          consent: { acknowledgedCloudAt: '2026-04-15T00:00:00.000Z' }
        }
      })),
      onStatusChanged: jest.fn(() => () => {})
    }
  };
});

afterEach(() => {
  delete global.window.electronAPI;
  window.localStorage.clear();
});

const renderSection = () => {
  const store = configureStore({ reducer: { aiProvider: aiProviderReducer } });
  return render(
    <Provider store={store}>
      <AIProviderSection addNotification={() => {}} />
    </Provider>
  );
};

test('renders the AI Provider section header', () => {
  renderSection();
  expect(screen.getByText(/AI Provider/i)).toBeInTheDocument();
});

test('shows the three default-provider radio options', async () => {
  renderSection();
  await waitFor(() => expect(screen.getByLabelText(/Default AI provider/i)).toBeInTheDocument());
  const group = within(screen.getByRole('radiogroup', { name: /Default AI provider/i }));
  expect(group.getByText(/Local Llama/i)).toBeInTheDocument();
  expect(group.getByText(/Anthropic Claude/i)).toBeInTheDocument();
  expect(group.getByText(/OpenAI \/ Custom/i)).toBeInTheDocument();
});

test('clicking Configure... opens the modal', async () => {
  renderSection();
  await waitFor(() => expect(screen.getAllByText(/Configure\.\.\./i).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(/Configure\.\.\./i)[0]);
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
});

describe('cloud AI consent gating', () => {
  test('switching to a cloud provider shows the consent modal first', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/Anthropic Claude/i)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Anthropic Claude/i));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Enable cloud AI/i);
    expect(window.electronAPI.aiProvider.setRouting).not.toHaveBeenCalled();
  });

  test('accepting consent calls setRouting and persists the flag', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/Anthropic Claude/i)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Anthropic Claude/i));

    fireEvent.click(await screen.findByRole('button', { name: /enable cloud ai/i }));

    await waitFor(() => expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledWith({ default: 'anthropic' });
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBe('1');
  });

  test('declining consent does NOT call setRouting and does NOT persist the flag', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/Anthropic Claude/i)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Anthropic Claude/i));

    fireEvent.click(await screen.findByRole('button', { name: /keep local/i }));

    expect(window.electronAPI.aiProvider.setRouting).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBeNull();
  });

  test('once acknowledged, subsequent cloud switches skip the modal', async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/Anthropic Claude/i)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Anthropic Claude/i));

    await waitFor(() => expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Enable cloud AI/i)).toBeNull();
  });

  test('switching to openaiCompatible also gates with the consent modal', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText(/OpenAI \/ Custom/i)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/OpenAI \/ Custom/i));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Enable cloud AI/i);
    expect(dialog.textContent).toMatch(/OpenAI/i);
    expect(window.electronAPI.aiProvider.setRouting).not.toHaveBeenCalled();
  });
});

describe('per-operation routing', () => {
  const withReadyAnthropic = () => {
    const routing = { default: 'local', perOperation: {}, perFolder: {} };
    window.electronAPI.aiProvider.getConfig = jest.fn(async () => ({
      success: true,
      settings: {
        providers: { local: { enabled: true }, anthropic: { enabled: true } },
        routing
      },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'anthropic', enabled: true, ready: true }
        ],
        routing
      }
    }));
  };

  test('renders one provider select per operation, on the app default', async () => {
    renderSection();
    const chat = await screen.findByLabelText('Chat');
    expect(chat.value).toBe('');
    expect(screen.getByLabelText('Document analysis')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization suggestions')).toBeInTheDocument();
    expect(
      within(chat).getByRole('option', { name: /Default \(Local Llama\)/ })
    ).toBeInTheDocument();
    // Providers that are not configured are visible but cannot be chosen.
    expect(within(chat).getByRole('option', { name: /Anthropic Claude/ })).toBeDisabled();
  });

  test('choosing Local Llama for chat calls setRouting for chat only, with no consent prompt', async () => {
    renderSection();
    const chat = await screen.findByLabelText('Chat');
    fireEvent.change(chat, { target: { value: 'local' } });
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledWith({
        perOperation: { chat: 'local' }
      })
    );
    expect(screen.queryByText(/Enable cloud AI/i)).toBeNull();
  });

  test('choosing a cloud provider for one operation gates on consent, then sets only that operation', async () => {
    withReadyAnthropic();
    renderSection();
    const chat = await screen.findByLabelText('Chat');
    await waitFor(() =>
      expect(within(chat).getByRole('option', { name: 'Anthropic Claude' })).not.toBeDisabled()
    );

    fireEvent.change(chat, { target: { value: 'anthropic' } });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Enable cloud AI/i);
    expect(window.electronAPI.aiProvider.setRouting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /enable cloud ai/i }));
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledWith({
        perOperation: { chat: 'anthropic' }
      })
    );
  });

  test('clearing an operation back to Default sends null for it', async () => {
    withReadyAnthropic();
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    renderSection();
    const chat = await screen.findByLabelText('Chat');
    await waitFor(() =>
      expect(within(chat).getByRole('option', { name: 'Anthropic Claude' })).not.toBeDisabled()
    );
    fireEvent.change(chat, { target: { value: 'anthropic' } });
    await waitFor(() => expect(window.electronAPI.aiProvider.setRouting).toHaveBeenCalledTimes(1));
    fireEvent.change(chat, { target: { value: '' } });
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setRouting).toHaveBeenLastCalledWith({
        perOperation: { chat: null }
      })
    );
  });
});
