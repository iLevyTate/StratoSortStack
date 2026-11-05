/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import ProcessingLimitsSection from '../../src/renderer/components/settings/ProcessingLimitsSection';
import aiProviderReducer from '../../src/renderer/store/slices/aiProviderSlice';

const LEGACY_CONSENT = { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' };

beforeEach(() => {
  window.localStorage.clear();
  window.electronAPI = {
    system: { getRecommendedConcurrency: jest.fn(async () => ({ maxConcurrent: 2 })) },
    aiProvider: {
      acknowledgeCloud: jest.fn(async () => ({
        success: true,
        status: {
          providers: [],
          consent: { acknowledgedCloudAt: '2026-02-02T00:00:00.000Z', version: 2 }
        }
      }))
    }
  };
});

function renderSection({ routing, consent }) {
  const store = configureStore({
    reducer: { aiProvider: aiProviderReducer },
    preloadedState: {
      aiProvider: {
        ...aiProviderReducer(undefined, { type: '@@init' }),
        settings: { providers: {}, routing, consent }
      }
    }
  });
  const latest = { settings: { captionVideoKeyframes: false } };
  function Harness() {
    const [settings, setSettings] = React.useState(latest.settings);
    latest.settings = settings;
    return <ProcessingLimitsSection settings={settings} setSettings={setSettings} />;
  }
  render(
    <Provider store={store}>
      <Harness />
    </Provider>
  );
  return latest;
}

const keyframeSwitch = () => screen.getByRole('switch', { name: /video keyframe descriptions/i });

describe('ProcessingLimitsSection — video keyframes and cloud consent', () => {
  test('with Analysis on a cloud provider and consent older than video frames, turning keyframes on asks first', async () => {
    const latest = renderSection({
      routing: { default: 'anthropic', perOperation: {}, perFolder: {} },
      consent: LEGACY_CONSENT
    });

    fireEvent.click(keyframeSwitch());
    expect(screen.getByTestId('cloud-ai-consent-modal')).toBeInTheDocument();
    expect(latest.settings.captionVideoKeyframes).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Enable cloud AI' }));
    await waitFor(() => expect(latest.settings.captionVideoKeyframes).toBe(true));
    expect(window.electronAPI.aiProvider.acknowledgeCloud).toHaveBeenCalledTimes(1);
  });

  test('declining the consent leaves keyframes off', () => {
    const latest = renderSection({
      routing: { default: 'local', perOperation: { analyze: 'openaiCompatible' }, perFolder: {} },
      consent: LEGACY_CONSENT
    });

    fireEvent.click(keyframeSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Keep local' }));
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
    expect(latest.settings.captionVideoKeyframes).toBe(false);
  });

  test('with Analysis local, or consent already current, the toggle applies at once', () => {
    const local = renderSection({
      routing: { default: 'local', perOperation: { chat: 'anthropic' }, perFolder: {} },
      consent: LEGACY_CONSENT
    });
    fireEvent.click(keyframeSwitch());
    expect(screen.queryByTestId('cloud-ai-consent-modal')).not.toBeInTheDocument();
    expect(local.settings.captionVideoKeyframes).toBe(true);
  });

  test('the switch description says frames can go to a cloud Analysis provider', () => {
    renderSection({ routing: { default: 'local', perFolder: {} }, consent: {} });
    expect(
      screen.getByText(/no frames are extracted or sent anywhere/i, { exact: false })
    ).toBeInTheDocument();
  });
});
