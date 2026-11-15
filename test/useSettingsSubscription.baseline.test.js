/**
 * Main broadcasts the whole settings object on every save, import and at
 * startup. With watchKeys, the first broadcast after mount must not report
 * every watched key as changed (Discover's "Updated text model, vision
 * model, embedding model" toast when nothing changed).
 */
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../src/shared/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

import { useSettingsSubscription } from '../src/renderer/hooks/useSettingsSubscription';

const WATCH = ['textModel', 'visionModel', 'embeddingModel'];
const CURRENT = {
  textModel: 'text.gguf',
  visionModel: 'vision.gguf',
  embeddingModel: 'embed.gguf',
  namingConvention: 'keep-original'
};

describe('useSettingsSubscription watched baseline', () => {
  let handlerRef;

  beforeEach(() => {
    handlerRef = { handler: null };
    window.electronAPI = {
      events: {
        onSettingsChanged: jest.fn((handler) => {
          handlerRef.handler = handler;
          return jest.fn();
        })
      }
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    jest.clearAllMocks();
  });

  test('first broadcast with unchanged models does not report a change', () => {
    const callback = jest.fn();
    renderHook(() => useSettingsSubscription(callback, { watchKeys: WATCH }));

    act(() => {
      // A naming change saved from Discover's dialog broadcasts everything.
      handlerRef.handler({ ...CURRENT, namingConvention: 'subject-date' });
    });

    expect(callback).not.toHaveBeenCalled();
  });

  test('seeds from current settings so a real first change is still reported', async () => {
    const get = jest.fn().mockResolvedValue({ ...CURRENT });
    window.electronAPI.settings = { get };
    const callback = jest.fn();
    renderHook(() => useSettingsSubscription(callback, { watchKeys: WATCH }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      handlerRef.handler({ ...CURRENT, textModel: 'other-text.gguf' });
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ textModel: 'other-text.gguf' });
  });

  test('a seed read that resolves after an event does not replace the newer values', async () => {
    let resolveGet;
    const get = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        })
    );
    window.electronAPI.settings = { get };
    const callback = jest.fn();
    renderHook(() => useSettingsSubscription(callback, { watchKeys: WATCH }));
    await waitFor(() => expect(get).toHaveBeenCalled());

    act(() => {
      handlerRef.handler({ ...CURRENT, textModel: 'new-text.gguf' });
    });
    expect(callback).not.toHaveBeenCalled();

    // Stale read from before the save.
    await act(async () => {
      resolveGet({ ...CURRENT });
      await Promise.resolve();
    });

    act(() => {
      handlerRef.handler({ ...CURRENT, textModel: 'new-text.gguf' });
    });
    expect(callback).not.toHaveBeenCalled();
  });

  test('a failed seed read falls back to the first broadcast as the baseline', async () => {
    const get = jest.fn().mockRejectedValue(new Error('ipc down'));
    window.electronAPI.settings = { get };
    const callback = jest.fn();
    renderHook(() => useSettingsSubscription(callback, { watchKeys: WATCH }));
    await waitFor(() => expect(get).toHaveBeenCalled());

    act(() => {
      handlerRef.handler({ ...CURRENT });
    });
    expect(callback).not.toHaveBeenCalled();

    act(() => {
      handlerRef.handler({ ...CURRENT, visionModel: 'other-vision.gguf' });
    });
    expect(callback).toHaveBeenCalledWith({ visionModel: 'other-vision.gguf' });
  });
});
