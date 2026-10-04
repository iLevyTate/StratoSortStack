/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

import aiProviderReducer from '../../src/renderer/store/slices/aiProviderSlice';
import SmartFolderAIOverrideField from '../../src/renderer/components/setup/SmartFolderAIOverrideField';

function renderField(statusProviders, override = '') {
  const store = configureStore({
    reducer: { aiProvider: aiProviderReducer },
    preloadedState: {
      aiProvider: {
        loaded: true,
        isWorking: false,
        lastError: null,
        settings: {
          providers: { local: { enabled: true } },
          routing: { default: 'local', perFolder: { 'folder-1': override } },
          consent: { acknowledgedCloudAt: '2026-01-01T00:00:00.000Z' }
        },
        status: { providers: statusProviders, routing: { default: 'local', perFolder: {} } },
        keyStatus: {},
        testResults: {}
      }
    }
  });

  return render(
    <Provider store={store}>
      <SmartFolderAIOverrideField folderId="folder-1" />
    </Provider>
  );
}

describe('SmartFolderAIOverrideField', () => {
  test('disables cloud providers that are enabled but not ready', () => {
    renderField([
      { id: 'local', displayName: 'Local Llama', enabled: true, ready: true },
      { id: 'openaiCompatible', displayName: 'OpenAI / Custom', enabled: true, ready: false }
    ]);

    const openAiOption = screen.getByRole('option', { name: /OpenAI \/ Custom \(not ready\)/i });
    expect(openAiOption).toBeDisabled();
  });

  test('shows hint when saved override is not ready', () => {
    renderField(
      [
        { id: 'local', displayName: 'Local Llama', enabled: true, ready: true },
        { id: 'openaiCompatible', displayName: 'OpenAI / Custom', enabled: true, ready: false }
      ],
      'openaiCompatible'
    );

    expect(screen.getByText(/saved override is not ready/i)).toBeInTheDocument();
  });
});
