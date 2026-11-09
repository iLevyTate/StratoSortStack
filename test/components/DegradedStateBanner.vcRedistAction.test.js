/**
 * @jest-environment jsdom
 *
 * The ai.vc-runtime-missing flag (raised by LlamaService when the native
 * engine cannot load because the Microsoft Visual C++ Redistributable is
 * missing) renders "Install now" (runs the installer bundled with Windows
 * packages through SYSTEM.INSTALL_VC_RUNTIME) and "Open download page".
 * Nothing runs or opens until the user clicks. After a successful install
 * the buttons give way to "Restart StratoSort"; when the installer is not
 * bundled, "Install now" falls back to Microsoft's download page.
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

const mockInstallVcRuntime = jest.fn();
const mockRelaunchApp = jest.fn();
jest.mock('../../src/renderer/services/ipc', () => ({
  whisperIpc: { installModel: jest.fn() },
  systemIpc: {
    installVcRuntime: (...args) => mockInstallVcRuntime(...args),
    relaunchApp: (...args) => mockRelaunchApp(...args)
  }
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

async function renderBanner() {
  render(<DegradedStateBanner />);
  await act(async () => {});
}

async function click(name) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('DegradedStateBanner VC++ runtime actions', () => {
  let openSpy;

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => Promise.resolve(mockFlags));
    mockInstallVcRuntime.mockReset();
    mockRelaunchApp.mockReset();
    mockFlags.length = 0;
    mockFlags.push({
      code: 'ai.vc-runtime-missing',
      subsystem: 'ai',
      severity: 'error',
      message: MESSAGE,
      detail: {
        missingDlls: ['msvcp140.dll', 'vcruntime140.dll'],
        action: { code: 'ai.install-vc-runtime', label: 'Install now' },
        secondaryAction: { code: 'ai.open-vc-redist-download', label: 'Open download page' }
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

  test('renders both buttons and runs or opens nothing until clicked', async () => {
    await renderBanner();

    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeInTheDocument();
    expect(mockInstallVcRuntime).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('Install now calls the install IPC (no arguments, no confirm) and offers a restart on success', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    mockInstallVcRuntime.mockResolvedValue({
      success: true,
      cancelled: false,
      needsRestart: false,
      exitCode: 0
    });
    await renderBanner();

    await click('Install now');

    expect(mockInstallVcRuntime).toHaveBeenCalledTimes(1);
    expect(mockInstallVcRuntime).toHaveBeenCalledWith();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Restart StratoSort to turn local AI on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open download page' })).not.toBeInTheDocument();
    // The flag is not dismissed: the engine needs a fresh process.
    expect(mockDispatch.mock.calls.some(([a]) => a?.type === 'system/dismissDegradedFlag')).toBe(
      false
    );

    mockRelaunchApp.mockResolvedValue({ success: true });
    await click('Restart StratoSort');
    expect(mockRelaunchApp).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  test('a reboot-required install (3010) says so and still offers the app restart', async () => {
    mockInstallVcRuntime.mockResolvedValue({ success: true, needsRestart: true, exitCode: 3010 });
    await renderBanner();

    await click('Install now');

    expect(screen.getByText(/Windows needs a PC restart to finish/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart StratoSort' })).toBeInTheDocument();
  });

  test('not bundled (dev build / zip without it): falls back to the download page', async () => {
    mockInstallVcRuntime.mockResolvedValue({ success: false, reason: 'not-bundled' });
    await renderBanner();

    await click('Install now');

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      VC_REDIST_DOWNLOAD_PAGE_URL,
      '_blank',
      'noopener,noreferrer'
    );
    expect(screen.getByText(/download page was opened/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart StratoSort' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
  });

  test('cancelled UAC/installer: explains and keeps both buttons', async () => {
    mockInstallVcRuntime.mockResolvedValue({ success: false, cancelled: true, exitCode: 1223 });
    await renderBanner();

    await click('Install now');

    expect(screen.getByText(/Installation was cancelled/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeEnabled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('signature could not be checked on this PC: neutral notice, not a failure', async () => {
    mockInstallVcRuntime.mockResolvedValue({
      success: false,
      cancelled: false,
      exitCode: null,
      reason: 'signature-unreadable',
      error: "Couldn't check the installer's signature on this PC"
    });
    await renderBanner();

    await click('Install now');

    expect(
      screen.getByText(
        "StratoSort couldn't check the installer's signature on this PC. Use Open download page instead."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not Microsoft-signed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeEnabled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  test('runtime already installed: says so and offers the app restart', async () => {
    mockInstallVcRuntime.mockResolvedValue({
      success: false,
      cancelled: false,
      exitCode: null,
      reason: 'already-installed',
      runtimePresent: true
    });
    await renderBanner();

    await click('Install now');

    expect(
      screen.getByText(
        'The Microsoft Visual C++ Redistributable is already installed. Restart StratoSort to turn local AI on.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart StratoSort' })).toBeInTheDocument();
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
  });

  test('another installation running (1618): asks to wait and keeps both buttons', async () => {
    mockInstallVcRuntime.mockResolvedValue({
      success: false,
      cancelled: false,
      exitCode: 1618,
      reason: 'install-in-progress',
      error: 'Another installation is already running on this PC'
    });
    await renderBanner();

    await click('Install now');

    expect(
      screen.getByText(
        'Another installation is running on this PC. Wait for it to finish, then click Install now again.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeEnabled();
  });

  test('installer failure: shows the error with the exit code and keeps the fallback', async () => {
    mockInstallVcRuntime.mockResolvedValue({
      success: false,
      cancelled: false,
      exitCode: 1603,
      reason: 'installer-failed',
      error: 'The installer exited with code 1603'
    });
    await renderBanner();

    await click('Install now');

    expect(screen.getByText(/Action failed: .*1603/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeInTheDocument();
  });

  test('Open download page opens the Microsoft page (same URL as main) without a confirm', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    await renderBanner();

    await click('Open download page');

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      VC_REDIST_DOWNLOAD_PAGE_URL,
      '_blank',
      'noopener,noreferrer'
    );
    expect(new URL(openSpy.mock.calls[0][0]).hostname).toBe('learn.microsoft.com');
    expect(mockInstallVcRuntime).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockDispatch.mock.calls.some(([a]) => a?.type === 'system/dismissDegradedFlag')).toBe(
      false
    );
    expect(screen.queryByText(/Action failed/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  test('a failed restart is shown inline', async () => {
    mockInstallVcRuntime.mockResolvedValue({ success: true, exitCode: 0 });
    mockRelaunchApp.mockRejectedValue(new Error('Restarting is unavailable'));
    await renderBanner();
    await click('Install now');

    await click('Restart StratoSort');

    expect(screen.getByText(/Action failed: Restarting is unavailable/)).toBeInTheDocument();
  });
});
