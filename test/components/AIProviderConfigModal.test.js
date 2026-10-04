/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/ui/Input', () => ({
  __esModule: true,
  default: (props) => <input {...props} />
}));

jest.mock('../../src/renderer/components/ui/Label', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <label {...props}>{children}</label>
}));

jest.mock('../../src/renderer/components/ui/Select', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <select {...props}>{children}</select>
}));

jest.mock('../../src/renderer/components/ui/Switch', () => ({
  __esModule: true,
  // The real Switch calls onChange with the next boolean, not an event.
  default: ({ checked, onChange, ...props }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(event) => onChange?.(event.target.checked)}
      {...props}
    />
  )
}));

jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  default: ({ children, footer }) => (
    <div data-testid="modal">
      {children}
      {footer}
    </div>
  ),
  ConfirmModal: () => null
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>,
  // CloudAIConsentModal (rendered by the consent-gate flow) uses Heading;
  // omitting it makes React render `undefined` and the whole flow crash.
  Heading: ({ children }) => <h2>{children}</h2>
}));

import aiProviderReducer, { testProvider } from '../../src/renderer/store/slices/aiProviderSlice';
import AIProviderConfigModal from '../../src/renderer/components/settings/AIProviderConfigModal';
import { CLOUD_AI_CONSENT_FLAG } from '../../src/renderer/components/common/CloudAIConsentModal';

function renderModal(store, { addNotification = jest.fn(), onClose = jest.fn() } = {}) {
  return render(
    <Provider store={store}>
      <AIProviderConfigModal
        provider="openaiCompatible"
        onClose={onClose}
        addNotification={addNotification}
      />
    </Provider>
  );
}

describe('AIProviderConfigModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.window.electronAPI = {
      aiProvider: {
        setProviderConfig: jest.fn(),
        setKey: jest.fn(),
        removeKey: jest.fn(),
        testProvider: jest.fn(async () => ({
          success: true,
          ok: true,
          latencyMs: 42
        })),
        acknowledgeCloud: jest.fn()
      }
    };
  });

  afterEach(async () => {
    // Drain React work still pending from this test's own async actions - a
    // dispatched thunk resolving, or a store notification React has not
    // processed yet - BEFORE tearing down the IPC surface and unmounting.
    // Left pending, that work landed during the NEXT test, where React then
    // dropped that test's setSaving(false) and its DOM froze on the stale
    // "Saving..." label, with no warning and no error to point at it.
    await act(async () => {});
    delete global.window.electronAPI;
    window.localStorage.clear();
  });

  test('Test connection requires cloud consent before dispatching testProvider', async () => {
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    const dispatchSpy = jest.spyOn(store, 'dispatch');

    renderModal(store);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByTestId('cloud-ai-consent-modal')).toBeInTheDocument();
    });

    expect(window.electronAPI.aiProvider.testProvider).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  test('Test connection runs when cloud consent is already acknowledged', async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perFolder: {} },
            consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
          },
          status: { providers: [], routing: { default: 'local', perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(window.electronAPI.aiProvider.testProvider).toHaveBeenCalled();
    });
  });

  test('Save key ignores a second click while in flight (SW-82)', async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    let resolveSave;
    window.electronAPI.aiProvider.setKey = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        })
    );

    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perFolder: {} },
            consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
          },
          status: { providers: [], routing: { default: 'local', perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: false, lastFour: null } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
    const saveButton = screen.getByRole('button', { name: /save key/i });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(window.electronAPI.aiProvider.setKey).toHaveBeenCalledTimes(1);
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveTextContent(/saving/i);

    await act(async () => {
      resolveSave({ success: true });
    });
  });

  test('turning a cloud provider off never asks for cloud consent and sends only enabled:false', async () => {
    // A user whose consent record is missing or invalid but has a provider
    // toggled on was shown "Enable cloud AI?" when trying to disable it.
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    const addNotification = jest.fn();
    renderModal(store, { addNotification });

    fireEvent.click(screen.getByLabelText('Enable this provider'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        { enabled: false }
      )
    );
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
    // The payload is the off switch and nothing else, so the toast must not
    // claim the whole form was stored.
    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith('Provider turned off.', 'success')
    );
    expect(addNotification).not.toHaveBeenCalledWith('Settings saved.', 'success');
  });

  test('saving with Enable off keeps the typed model / base URL / cap instead of discarding them', async () => {
    // F18: the pre-consent "turning it off needs no consent" short-circuit
    // fired on ANY save with Enable off and sent a bare { enabled: false },
    // throwing away the base URL / model / cap the user had just typed while
    // still toasting "Settings saved.". The exemption is only correct when
    // disabling is the whole change; anything wider has to go through the
    // consent prompt and be replayed in full.
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    window.electronAPI.aiProvider.acknowledgeCloud = jest.fn(async () => ({
      success: true,
      status: { providers: [], consent: { acknowledgedCloudAt: '2026-02-02T00:00:00.000Z' } }
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: false,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    const addNotification = jest.fn();
    renderModal(store, { addNotification });

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://localhost:1234/v1' }
    });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen2.5-7b' } });
    fireEvent.change(screen.getByLabelText('Monthly spend cap in USD'), { target: { value: '7' } });
    // Enable stays off — the user is wiring the provider up before turning it on.
    expect(screen.getByLabelText('Enable this provider')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Nothing may be written before consent: a bare { enabled: false } here
    // would silently drop the three edits above.
    await waitFor(() => expect(screen.getByTestId('cloud-ai-consent-modal')).toBeInTheDocument());
    expect(window.electronAPI.aiProvider.setProviderConfig).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalledWith('Settings saved.', 'success');
    expect(addNotification).not.toHaveBeenCalledWith('Provider turned off.', 'success');

    fireEvent.click(screen.getByRole('button', { name: /enable cloud ai/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        {
          enabled: false,
          model: 'qwen2.5-7b',
          baseUrl: 'http://localhost:1234/v1',
          spendCapMonthlyUsd: 7
        }
      )
    );
    await waitFor(() =>
      expect(store.getState().aiProvider.settings.providers.openaiCompatible).toMatchObject({
        enabled: false,
        model: 'qwen2.5-7b',
        baseUrl: 'http://localhost:1234/v1',
        spendCapMonthlyUsd: 7
      })
    );
    expect(addNotification).toHaveBeenCalledWith('Settings saved.', 'success');
  });

  test('a save that changes nothing but the off switch is still exempt from consent', async () => {
    // The narrowed exemption must keep cb376d47's privacy intent: a provider
    // that is already off, re-saved with no edits, must not demand consent.
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              // No model/baseUrl/cap stored at all: the form seeds its own
              // defaults, which must not read as user edits.
              openaiCompatible: { enabled: false }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: false, lastFour: null } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        { enabled: false }
      )
    );
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
  });

  test('turning the provider off with other fields dirty disables it without a consent prompt', async () => {
    // After the F18 narrowing this save fell through to the cloud-consent
    // prompt, so a consent-less user switching cloud OFF was asked "Enable
    // cloud AI with OpenAI / Custom?" — and DECLINING left the provider
    // ENABLED (handleSave returned after queueing the consent action and
    // nothing disabled it). An attempt to turn cloud off must land whatever
    // the consent answer would have been, and must not be fronted by a dialog
    // asking to enable the thing being switched off.
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    window.electronAPI.aiProvider.acknowledgeCloud = jest.fn(async () => ({
      success: true,
      status: { providers: [], consent: { acknowledgedCloudAt: '2026-03-03T00:00:00.000Z' } }
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    const addNotification = jest.fn();
    const onClose = jest.fn();
    renderModal(store, { addNotification, onClose });

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'qwen2.5-7b' } });
    fireEvent.click(screen.getByLabelText('Enable this provider'));
    expect(screen.getByLabelText('Enable this provider')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // The off switch is written immediately, with no consent dialog in the way.
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        { enabled: false }
      )
    );
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(store.getState().aiProvider.settings.providers.openaiCompatible.enabled).toBe(false)
    );
    // The edit that payload does NOT carry is reported as a warning, never as
    // a success toast claiming the whole form was stored.
    expect(addNotification).toHaveBeenCalledWith(
      expect.stringContaining('Provider turned off.'),
      'warning'
    );
    expect(addNotification).not.toHaveBeenCalledWith('Settings saved.', 'success');
    expect(addNotification).not.toHaveBeenCalledWith('Provider turned off.', 'success');
    // ...and the modal stays open holding the typed value so it is not lost.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Model')).toHaveValue('qwen2.5-7b');

    // Saving again is a plain config save on an already-off provider — that is
    // where the consent prompt belongs, and accepting stores the whole form
    // (still disabled). findByRole waits out the in-flight "Saving…" label.
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByTestId('cloud-ai-consent-modal')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /enable cloud ai/i }));
    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenLastCalledWith(
        'openaiCompatible',
        {
          enabled: false,
          model: 'qwen2.5-7b',
          baseUrl: 'https://api.openai.com/v1',
          spendCapMonthlyUsd: null
        }
      )
    );
  });

  test('stray whitespace in Model / Base URL is not an edit, so a plain disable stays exempt', async () => {
    // The delta check normalizes both sides: without it a trailing space left
    // in a field read as a dirty edit and turned an otherwise clean disable
    // into a consent prompt (and, with the P1 fix, a "changes not saved"
    // warning). It is also never persisted.
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: {}
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    const addNotification = jest.fn();
    renderModal(store, { addNotification });

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-4o ' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: ' https://api.openai.com/v1' }
    });
    fireEvent.click(screen.getByLabelText('Enable this provider'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        { enabled: false }
      )
    );
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith('Provider turned off.', 'success')
    );
  });

  test('says when spend tracking cannot verify the cap and when the cap is reached', async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {
        anthropic: { inputTokens: 0, outputTokens: 0, estCostUsd: 0 },
        openaiCompatible: { inputTokens: 1000, outputTokens: 200, estCostUsd: 1.5 }
      },
      health: { loaded: false, loadError: 'corrupt json', persistFailureCount: 0, degraded: true }
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o',
                spendCapMonthlyUsd: 1
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    await screen.findByText(/Spent this month: \$1\.50/);
    expect(screen.getByText(/The monthly cap is reached/)).toBeInTheDocument();
    expect(screen.getByText(/corrupt json/)).toBeInTheDocument();
    expect(screen.getByText(/refused until it recovers/)).toBeInTheDocument();
  });

  test("Save sends the spend cap as a number and shows this month's spend", async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {
        anthropic: { inputTokens: 0, outputTokens: 0, estCostUsd: 0 },
        openaiCompatible: { inputTokens: 1000, outputTokens: 200, estCostUsd: 1.5 }
      },
      health: { loaded: true, degraded: false }
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o'
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    await screen.findByText(/Spent this month: \$1\.50/);
    fireEvent.change(screen.getByLabelText('Monthly spend cap in USD'), {
      target: { value: '25' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        expect.objectContaining({ spendCapMonthlyUsd: 25 })
      )
    );
  });

  test('Save with an empty cap sends null so the cap is cleared', async () => {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
    window.electronAPI.aiProvider.setProviderConfig = jest.fn(async () => ({
      success: true,
      status: { providers: [] }
    }));
    window.electronAPI.aiProvider.getUsage = jest.fn(async () => ({
      success: true,
      thisMonth: {}
    }));
    const store = configureStore({
      reducer: { aiProvider: aiProviderReducer },
      preloadedState: {
        aiProvider: {
          loaded: true,
          isWorking: false,
          lastError: null,
          settings: {
            providers: {
              openaiCompatible: {
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-4o',
                spendCapMonthlyUsd: 40
              }
            },
            routing: { default: 'local', perOperation: {}, perFolder: {} },
            consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
          },
          status: { providers: [], routing: { default: 'local', perOperation: {}, perFolder: {} } },
          keyStatus: { openaiCompatible: { hasKey: true, lastFour: '1234' } },
          testResults: {}
        }
      }
    });

    renderModal(store);

    const cap = screen.getByLabelText('Monthly spend cap in USD');
    expect(cap.value).toBe('40');
    fireEvent.change(cap, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.aiProvider.setProviderConfig).toHaveBeenCalledWith(
        'openaiCompatible',
        expect.objectContaining({ spendCapMonthlyUsd: null })
      )
    );
  });
});
