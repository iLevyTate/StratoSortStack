/**
 * @jest-environment jsdom
 *
 * Renderer half of the autoDownload:false update flow (backlog: "renderer-side
 * invocation needs verification"): main emits app:update payloads; this
 * component must invoke system.downloadUpdate() on 'available', surface
 * failures, and expose the Apply button that calls system.applyUpdate().
 */
'use strict';
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockAddNotification = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mockAddNotification })
}));

import UpdateIndicator from '../../src/renderer/components/UpdateIndicator';

describe('UpdateIndicator (auto-updater renderer wiring)', () => {
  let updateHandler;
  let unsubscribe;

  beforeEach(() => {
    jest.clearAllMocks();
    updateHandler = null;
    unsubscribe = jest.fn();
    window.electronAPI = {
      events: {
        onAppUpdate: jest.fn((handler) => {
          updateHandler = handler;
          return unsubscribe;
        })
      },
      system: {
        downloadUpdate: jest.fn().mockResolvedValue({ success: true }),
        applyUpdate: jest.fn().mockResolvedValue({ success: true })
      }
    };
  });

  test("'available' payload triggers downloadUpdate (autoDownload is off in main)", async () => {
    render(<UpdateIndicator />);
    expect(updateHandler).toBeInstanceOf(Function);

    await act(async () => {
      updateHandler({ status: 'available' });
    });

    expect(window.electronAPI.system.downloadUpdate).toHaveBeenCalledTimes(1);
    // Still downloading — no button yet.
    expect(screen.queryByRole('button', { name: 'Apply update' })).not.toBeInTheDocument();
  });

  test('download failure surfaces an error notification', async () => {
    window.electronAPI.system.downloadUpdate.mockResolvedValue({
      success: false,
      error: 'feed unreachable'
    });
    render(<UpdateIndicator />);

    await act(async () => {
      updateHandler({ status: 'available' });
    });

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        'feed unreachable',
        'error',
        7000,
        'update-error'
      )
    );
  });

  test('download IPC rejection surfaces an error notification', async () => {
    window.electronAPI.system.downloadUpdate.mockRejectedValue(new Error('channel torn down'));
    render(<UpdateIndicator />);

    await act(async () => {
      updateHandler({ status: 'available' });
    });

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        'channel torn down',
        'error',
        7000,
        'update-error'
      )
    );
  });

  test("'ready' payload reveals the Apply button which invokes applyUpdate", async () => {
    render(<UpdateIndicator />);

    await act(async () => {
      updateHandler({ status: 'ready' });
    });

    const button = screen.getByRole('button', { name: 'Apply update' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(window.electronAPI.system.applyUpdate).toHaveBeenCalledTimes(1);
  });

  test('apply failure surfaces an error notification', async () => {
    window.electronAPI.system.applyUpdate.mockResolvedValue({ success: false });
    render(<UpdateIndicator />);

    await act(async () => {
      updateHandler({ status: 'ready' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply update' }));
    });

    await waitFor(() =>
      expect(mockAddNotification).toHaveBeenCalledWith(
        'Failed to apply the downloaded update. Try again from Settings.',
        'error',
        7000,
        'update-error'
      )
    );
  });

  test('invalid payloads are ignored without side effects', async () => {
    render(<UpdateIndicator />);

    await act(async () => {
      updateHandler(null);
      updateHandler({});
      updateHandler({ status: 'unknown-status' });
    });

    expect(window.electronAPI.system.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAddNotification).not.toHaveBeenCalled();
  });

  test('unmount unsubscribes the update listener', () => {
    const { unmount } = render(<UpdateIndicator />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
