/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import DownloadsTriageView from '../../../../src/renderer/components/triage/DownloadsTriageView';

jest.mock('react-redux', () => ({
  useSelector: jest.fn((selector) =>
    selector({
      system: { redactPaths: false, redactPathsLoaded: true }
    })
  )
}));

jest.mock('../../../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({
    openFile: jest.fn(),
    revealFile: jest.fn()
  })
}));

jest.mock('../../../../src/shared/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

describe('DownloadsTriageView trash selection', () => {
  function mountTriageApi(overrides = {}) {
    const api = {
      downloads: {
        triage: {
          start: jest.fn().mockResolvedValue({
            success: true,
            triageId: 't-session-1',
            folderPath: '/tmp/downloads',
            buckets: {
              keep: [],
              trash: [
                {
                  filePath: '/tmp/downloads/a.txt',
                  fileName: 'a.txt',
                  size: 10,
                  why: 'duplicate',
                  confidence: 1
                },
                {
                  filePath: '/tmp/downloads/b.txt',
                  fileName: 'b.txt',
                  size: 10,
                  why: 'duplicate',
                  confidence: 1
                }
              ],
              excluded: [],
              ambiguous: [],
              review: [],
              unmatched: []
            }
          }),
          deepScan: jest.fn(),
          act: jest.fn(),
          ...overrides.triage
        }
      }
    };
    global.window.electronAPI = api;
    window.electronAPI = api;
    return api;
  }

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mountTriageApi();
  });

  test('user can clear trash selection without re-select-all loop', async () => {
    render(<DownloadsTriageView isOpen onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Scan Downloads/i }));

    await screen.findByTitle('Session t-session-1');

    const rowA = await screen.findByRole('checkbox', { name: /Select a\.txt/i });
    const rowB = screen.getByRole('checkbox', { name: /Select b\.txt/i });
    await waitFor(() => {
      expect(rowA).toBeChecked();
      expect(rowB).toBeChecked();
    });

    const selectAll = screen.getByRole('checkbox', { name: /Select all in current tab/i });
    fireEvent.click(selectAll);
    expect(selectAll).not.toBeChecked();
    expect(rowA).not.toBeChecked();
    expect(rowB).not.toBeChecked();

    await waitFor(() => {
      expect(rowA).not.toBeChecked();
      expect(rowB).not.toBeChecked();
    });
  });

  test('NO_SESSION resets tab and clears session chrome', async () => {
    mountTriageApi({
      triage: {
        act: jest.fn().mockResolvedValue({
          success: false,
          errorCode: 'NO_SESSION'
        })
      }
    });

    render(<DownloadsTriageView isOpen onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Scan Downloads/i }));

    await screen.findByTitle('Session t-session-1');
    await screen.findByRole('checkbox', { name: /Select a\.txt/i });

    fireEvent.click(screen.getByRole('button', { name: /Ignore/i }));

    await screen.findByText(/Session expired/);
    expect(screen.queryByTitle('Session t-session-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan Downloads/i })).toBeEnabled();
  });
});
