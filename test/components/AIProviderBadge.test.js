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
import AIProviderBadge from '../../src/renderer/components/common/AIProviderBadge';

const renderWith = (preload) => {
  const store = configureStore({
    reducer: { aiProvider: aiProviderReducer },
    preloadedState: { aiProvider: preload }
  });
  return render(
    <Provider store={store}>
      <AIProviderBadge />
    </Provider>
  );
};

const baseState = {
  loaded: true,
  isWorking: false,
  lastError: null,
  settings: {
    providers: { local: { enabled: true }, anthropic: { enabled: false } },
    routing: { default: 'local', perFolder: {} }
  },
  status: {
    providers: [{ id: 'local', enabled: true, ready: true }],
    routing: { default: 'local', perFolder: {} }
  },
  keyStatus: {
    anthropic: { hasKey: false, lastFour: null },
    openaiCompatible: { hasKey: false, lastFour: null }
  },
  testResults: {}
};

describe('AIProviderBadge', () => {
  test('renders nothing when default provider is local', () => {
    const { container } = renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing: { default: 'local', perFolder: {} } }
    });
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing when cloud is default but provider is not ready', () => {
    const { container } = renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing: { default: 'openaiCompatible', perFolder: {} } },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'openaiCompatible', enabled: true, ready: false }
        ],
        routing: { default: 'openaiCompatible', perFolder: {} }
      }
    });
    expect(container).toBeEmptyDOMElement();
  });

  test('renders badge when default provider is anthropic and ready', () => {
    renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing: { default: 'anthropic', perFolder: {} } },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'anthropic', enabled: true, ready: true }
        ],
        routing: { default: 'anthropic', perFolder: {} }
      }
    });
    const badge = screen.getByRole('status', { name: /cloud ai — anthropic claude/i });
    expect(badge).toBeInTheDocument();
  });

  test('renders OpenAI label when default is openaiCompatible and ready', () => {
    renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing: { default: 'openaiCompatible', perFolder: {} } },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'openaiCompatible', enabled: true, ready: true }
        ],
        routing: { default: 'openaiCompatible', perFolder: {} }
      }
    });
    const badge = screen.getByRole('status', { name: /cloud ai — openai/i });
    expect(badge).toBeInTheDocument();
  });

  test('renders nothing when aiProvider state is missing (pre-load)', () => {
    const store = configureStore({ reducer: { aiProvider: aiProviderReducer } });
    const { container } = render(
      <Provider store={store}>
        <AIProviderBadge />
      </Provider>
    );
    // Default routing is 'local' so badge should not show.
    expect(container).toBeEmptyDOMElement();
  });

  test('renders when only one operation is routed to a ready cloud provider, naming each route', () => {
    const routing = { default: 'local', perOperation: { chat: 'anthropic' }, perFolder: {} };
    renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'anthropic', enabled: true, ready: true }
        ],
        routing
      }
    });
    const badge = screen.getByRole('status');
    const label = badge.getAttribute('aria-label');
    expect(label).toMatch(/chat on Anthropic Claude/);
    expect(label).toMatch(/document analysis on Local Llama/);
    expect(label).toMatch(/organization suggestions on Local Llama/);
  });

  test('renders nothing when the only cloud-routed operation points at a provider that is not ready', () => {
    const routing = { default: 'local', perOperation: { chat: 'openaiCompatible' }, perFolder: {} };
    const { container } = renderWith({
      ...baseState,
      settings: { ...baseState.settings, routing },
      status: {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'openaiCompatible', enabled: true, ready: false }
        ],
        routing
      }
    });
    expect(container).toBeEmptyDOMElement();
  });
});
