/**
 * @jest-environment jsdom
 *
 * A system-health banner carries the short message, but the code and the
 * underlying system error (EPERM, ENOSPC) are what a bug report needs. "Copy
 * details" puts all of it on the clipboard; nothing leaves the machine.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

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
  whisperIpc: { installModel: jest.fn() },
  systemIpc: { installVcRuntime: jest.fn(), relaunchApp: jest.fn() }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

import DegradedStateBanner from '../../src/renderer/components/layout/DegradedStateBanner';

const MESSAGE = 'StratoSort could not save its search index.';

async function renderBanner() {
  render(<DegradedStateBanner />);
  await act(async () => {});
}

describe('DegradedStateBanner Copy details', () => {
  let writeText;

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => Promise.resolve(mockFlags));
    mockFlags.length = 0;
    mockFlags.push({
      code: 'orama.save-failed',
      subsystem: 'vector-db',
      severity: 'error',
      message: MESSAGE,
      detail: { errno: 'EPERM', error: 'operation not permitted' },
      raisedAt: 1,
      lastSeenAt: 1,
      count: 1,
      dismissed: false
    });
    writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    delete navigator.clipboard;
  });

  test('copies the message, the code and the system error', async () => {
    await renderBanner();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Copy details for "${MESSAGE}"` }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0];
    expect(text).toContain(MESSAGE);
    expect(text).toContain('Code: orama.save-failed');
    expect(text).toContain('System error: EPERM');
    expect(text).toContain('operation not permitted');
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  test('a flag without detail copies the message and code only', async () => {
    mockFlags[0] = { ...mockFlags[0], detail: undefined };
    await renderBanner();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Copy details for "${MESSAGE}"` }));
    });

    expect(writeText).toHaveBeenCalledWith(`${MESSAGE}\nCode: orama.save-failed`);
  });

  test('an error banner is labelled "Problem", not "Degraded mode"', async () => {
    await renderBanner();

    expect(screen.getByText('Problem:')).toBeInTheDocument();
    expect(screen.queryByText(/Degraded mode/)).toBeNull();
  });
});
