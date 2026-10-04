/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import CloudAIConsentModal, {
  CLOUD_AI_CONSENT_FLAG,
  hasAcknowledgedCloudAI
} from '../../src/renderer/components/common/CloudAIConsentModal';
import aiProviderReducer from '../../src/renderer/store/slices/aiProviderSlice';

beforeEach(() => {
  window.localStorage.clear();
  // Mock the preload bridge that the consent thunk now talks to. Default
  // resolves with a status payload — individual tests override for failures.
  window.electronAPI = {
    aiProvider: {
      acknowledgeCloud: jest.fn(async () => ({
        success: true,
        status: {
          providers: [],
          routing: { default: 'local', perFolder: {} },
          consent: { acknowledgedCloudAt: '2026-04-15T00:00:00.000Z' }
        }
      }))
    }
  };
});

function renderWithStore(ui, { preloaded } = {}) {
  const store = configureStore({
    reducer: { aiProvider: aiProviderReducer },
    preloadedState: preloaded
  });
  return { store, ...render(<Provider store={store}>{ui}</Provider>) };
}

describe('CloudAIConsentModal', () => {
  test('hasAcknowledgedCloudAI returns false before any acknowledgment (no state, no flag)', () => {
    expect(hasAcknowledgedCloudAI()).toBe(false);
  });

  test('hasAcknowledgedCloudAI returns true when state has acknowledgedCloudAt', () => {
    expect(
      hasAcknowledgedCloudAI({
        aiProvider: {
          settings: { consent: { acknowledgedCloudAt: '2026-04-15T00:00:00.000Z' } }
        }
      })
    ).toBe(true);
  });

  test('hasAcknowledgedCloudAI falls back to localStorage flag when state is empty', () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    expect(hasAcknowledgedCloudAI()).toBe(true);
    expect(hasAcknowledgedCloudAI({ aiProvider: { settings: {} } })).toBe(true);
  });

  test('renders dialog with provider name when open', () => {
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={() => {}} />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/Anthropic Claude/i);
  });

  test('clicking Accept calls IPC acknowledgeCloud, sets localStorage, and fires onAccept', async () => {
    const onAccept = jest.fn();
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={onAccept} onDecline={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: /enable cloud ai/i }));
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.acknowledgeCloud).toHaveBeenCalledTimes(1)
    );
    expect(onAccept).toHaveBeenCalledTimes(1);
    // Authoritative consent is in main process; localStorage is the fast path.
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBe('1');
  });

  test('does NOT fire onAccept and does NOT set localStorage when IPC rejects', async () => {
    // Reject with a structured response (matching how throwIfFailed normally
    // throws) instead of throwing — test stability across React 19's updated
    // async error boundaries.
    window.electronAPI.aiProvider.acknowledgeCloud = jest.fn(() =>
      Promise.reject(Object.assign(new Error('main process refused'), { code: 'BACKEND_ERROR' }))
    );
    const onAccept = jest.fn();
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={onAccept} onDecline={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: /enable cloud ai/i }));
    // Verify the IPC was called (proves the click reached the thunk).
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.acknowledgeCloud).toHaveBeenCalledTimes(1)
    );
    // The component should NOT have advanced to onAccept and should NOT have
    // persisted the localStorage flag, regardless of whether the error UI
    // happens to render at this point in the React lifecycle.
    expect(onAccept).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBeNull();
  });

  test('clicking Decline fires onDecline and does NOT persist flag or call IPC', () => {
    const onDecline = jest.fn();
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={onDecline} />
    );
    fireEvent.click(screen.getByRole('button', { name: /keep local/i }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBeNull();
    expect(window.electronAPI.aiProvider.acknowledgeCloud).not.toHaveBeenCalled();
  });

  test('shows openaiCompatible label when provider is openaiCompatible', () => {
    renderWithStore(
      <CloudAIConsentModal provider="openaiCompatible" onAccept={() => {}} onDecline={() => {}} />
    );
    expect(screen.getByRole('dialog').textContent).toMatch(/OpenAI/i);
  });

  test('Escape declines, mirroring the Keep-local button (U-011)', () => {
    const onDecline = jest.fn();
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={onDecline} />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG)).toBeNull();
  });

  test('overlay and panel use the shared Modal visual tokens (U-T7)', () => {
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={() => {}} />
    );

    const overlay = screen.getByTestId('cloud-ai-consent-modal');
    expect(overlay.style.backgroundColor).toBe('var(--overlay-scrim)');
    expect(overlay.className).not.toMatch(/bg-black/);

    const panel = overlay.firstElementChild;
    expect(panel.className).toContain('rounded-2xl');
    expect(panel.className).toContain('shadow-2xl');
    expect(panel.className).toContain('border-border-soft');
    expect(panel.style.backgroundColor).toBe('var(--surface-raised)');
  });

  test('title carries the shared Modal heading recipe (U-T1)', () => {
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={() => {}} />
    );

    const title = screen.getByRole('heading', { level: 2, name: /Enable cloud AI/ });
    // Heading as="h2" variant="h4" — identical recipe to ui/Modal's title.
    expect(title.className).toContain('text-xl');
    expect(title.className).toContain('font-medium');
    expect(title.className).toContain('text-system-gray-900');
  });

  test('actions use the canonical ui/Button variants, not raw buttons (U-T11)', () => {
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={() => {}} />
    );

    const decline = screen.getByRole('button', { name: 'Keep local' });
    const accept = screen.getByRole('button', { name: 'Enable cloud AI' });
    expect(decline.className).toContain('btn-secondary');
    expect(accept.className).toContain('btn-primary');
    // The old hand-rolled recipe must be gone (color classes lived inline).
    expect(decline.className).not.toMatch(/border-system-gray-300/);
    expect(accept.className).not.toMatch(/bg-stratosort-blue/);
  });
});

describe('CloudAIConsentModal privacy copy', () => {
  test('says what cloud mode actually sends: per-question chat passages and OCR text, never embeddings', () => {
    renderWithStore(
      <CloudAIConsentModal provider="anthropic" onAccept={() => {}} onDecline={() => {}} />
    );
    const dialog = screen.getByRole('dialog');
    // The old copy promised "once per analysis" with chats reusing a cache;
    // chat sends fresh passages on every question (audit PV-01, PV-02).
    expect(dialog).toHaveTextContent(/every chat question/i);
    expect(dialog).toHaveTextContent(/text read from images by OCR/i);
    expect(dialog).toHaveTextContent(/Embeddings are always computed locally/i);
    expect(dialog).not.toHaveTextContent(/once per analysis/i);
    // Deep mode retrieves up to twelve sources, and the stored consent is one
    // provider-agnostic record; the copy says both.
    expect(dialog).toHaveTextContent(/up to twelve in Deep mode/i);
    expect(dialog).toHaveTextContent(/any cloud provider or OpenAI-compatible endpoint/i);
  });
});
