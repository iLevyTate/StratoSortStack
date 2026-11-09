/**
 * @jest-environment jsdom
 *
 * The ai.vc-runtime-missing flag (raised by LlamaService when the native
 * engine cannot load because the Microsoft Visual C++ Redistributable is
 * missing) renders an "Open download page" action. Microsoft's page opens
 * only when the user clicks, and the flag stays up (a restart is needed).
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockDispatch = jest.fn();
const mockFlags = [];
jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) =>
    selector({
      system: { degradedFlags: mockFlags },
      files: { smartFoldersError: null },
      ui: { settingsError: null }
    })
}));

jest.mock('../../src/renderer/store/slices/systemSlice', () => ({
  fetchDegradedState: () => ({ type: 'system/fetchDegradedState' }),
  dismissDegradedFlag: (code) => ({ type: 'system/dismissDegradedFlag', payload: code })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  whisperIpc: { installModel: jest.fn() }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

import DegradedStateBanner from '../../src/renderer/components/layout/DegradedStateBanner';

const { VC_REDIST_DOWNLOAD_PAGE_URL } = jest.requireActual(
  '../../src/main/utils/vcRuntimeDetection'
);

const MESSAGE =
  "Local AI needs the Microsoft Visual C++ Redistributable (x64), which isn't installed on this PC. Install it from Microsoft, then restart StratoSort.";

describe('DegradedStateBanner VC++ runtime action', () => {
  let openSpy;

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => Promise.resolve(mockFlags));
    mockFlags.length = 0;
    mockFlags.push({
      code: 'ai.vc-runtime-missing',
      subsystem: 'ai',
      severity: 'error',
      message: MESSAGE,
      detail: {
        missingDlls: ['msvcp140.dll', 'vcruntime140.dll'],
        action: { code: 'ai.open-vc-redist-download', label: 'Open download page' }
      },
      raisedAt: 1,
      lastSeenAt: 1,
      count: 1,
      dismissed: false
    });
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('renders the message and an action button, and opens nothing until clicked', async () => {
    render(<DegradedStateBanner />);
    await act(async () => {});

    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('clicking opens the Microsoft download page (same URL as main) without a confirm', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    render(<DegradedStateBanner />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open download page' }));
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      VC_REDIST_DOWNLOAD_PAGE_URL,
      '_blank',
      'noopener,noreferrer'
    );
    expect(new URL(openSpy.mock.calls[0][0]).hostname).toBe('learn.microsoft.com');
    expect(confirmSpy).not.toHaveBeenCalled();
    // The action does not dismiss the flag: the engine still needs a restart.
    expect(mockDispatch.mock.calls.some(([a]) => a?.type === 'system/dismissDegradedFlag')).toBe(
      false
    );
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
