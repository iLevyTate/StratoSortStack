/**
 * @jest-environment jsdom
 *
 * F-204 (K-20): the smart-folder watcher exposes a status API that no
 * renderer ever consumed, so adding a folder yielded one toast and silence.
 * This line under the folder list says what the watcher is doing.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import WatcherStatusLine from '../../src/renderer/components/setup/WatcherStatusLine';

function arm(status, { fail = false } = {}) {
  const watcherStatus = fail
    ? jest.fn().mockRejectedValue(new Error('ipc down'))
    : jest.fn().mockResolvedValue({ success: true, status });
  window.electronAPI = { smartFolders: { watcherStatus } };
  return watcherStatus;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('WatcherStatusLine', () => {
  afterEach(() => {
    delete window.electronAPI;
    jest.useRealTimers();
  });

  test('says how many folders are watched and that the index is up to date', async () => {
    arm({ available: true, isRunning: true, watchedCount: 3, queueLength: 0, processingCount: 0 });
    render(<WatcherStatusLine folderCount={3} />);
    await flush();
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/Watching 3 folders/);
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/up to date/i);
  });

  test('shows in-flight work when files are queued or being analyzed', async () => {
    arm({ available: true, isRunning: true, watchedCount: 1, queueLength: 4, processingCount: 2 });
    render(<WatcherStatusLine folderCount={1} />);
    await flush();
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/Watching 1 folder\b/);
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/6 files being analyzed/);
  });

  test('warns when watching is off so new files will not be picked up', async () => {
    arm({ available: true, isRunning: false, isStarting: false, watchedCount: 0 });
    render(<WatcherStatusLine folderCount={2} />);
    await flush();
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/not being watched/i);
    expect(screen.getByTestId('watcher-status')).toHaveTextContent(/Auto-organize/);
  });

  test('renders nothing without folders, without the API, or when the call fails', async () => {
    arm({ available: true, isRunning: true, watchedCount: 0 });
    const { unmount } = render(<WatcherStatusLine folderCount={0} />);
    await flush();
    expect(screen.queryByTestId('watcher-status')).not.toBeInTheDocument();
    unmount();

    delete window.electronAPI;
    const second = render(<WatcherStatusLine folderCount={2} />);
    await flush();
    expect(screen.queryByTestId('watcher-status')).not.toBeInTheDocument();
    second.unmount();

    arm(null, { fail: true });
    render(<WatcherStatusLine folderCount={2} />);
    await flush();
    expect(screen.queryByTestId('watcher-status')).not.toBeInTheDocument();
  });

  test('polls on an interval and stops on unmount', async () => {
    jest.useFakeTimers();
    const watcherStatus = arm({ available: true, isRunning: true, watchedCount: 1 });
    const { unmount } = render(<WatcherStatusLine folderCount={1} intervalMs={5000} />);
    await flush();
    expect(watcherStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(watcherStatus).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(watcherStatus).toHaveBeenCalledTimes(2);
  });
});
