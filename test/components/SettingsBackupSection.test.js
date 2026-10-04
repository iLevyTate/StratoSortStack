/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));
jest.mock('../../src/renderer/components/ui/IconButton', () => ({
  __esModule: true,
  default: ({ icon, ...props }) => (
    <button {...props}>
      {icon}
      refresh
    </button>
  )
}));
jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ children, headerAction }) => (
    <div>
      {headerAction}
      {children}
    </div>
  )
}));
jest.mock('../../src/renderer/components/ui/StateMessage', () => ({
  __esModule: true,
  default: ({ title }) => <div>{title}</div>
}));
jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));
jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ debug: jest.fn() })
}));

import SettingsBackupSection from '../../src/renderer/components/settings/SettingsBackupSection';

describe('SettingsBackupSection', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  test('an import that succeeded with reservations says so', async () => {
    window.electronAPI = {
      settings: {
        listBackups: jest.fn(async () => ({ success: true, backups: [] })),
        import: jest.fn(async () => ({
          success: true,
          warnings: ['maxConcurrentAnalysis was clamped to 8']
        }))
      }
    };
    const addNotification = jest.fn();
    const { getByRole } = render(<SettingsBackupSection addNotification={addNotification} />);

    await act(async () => {
      getByRole('button', { name: /import/i }).click();
    });

    expect(addNotification).toHaveBeenCalledWith(
      'Settings imported. Reload to apply changes.',
      'success'
    );
    expect(addNotification).toHaveBeenCalledWith(
      'Imported with a warning: maxConcurrentAnalysis was clamped to 8',
      'warning',
      8000,
      'settings-restore-warning'
    );
  });

  test('does not set state after unmount during async backup load', async () => {
    let resolveBackups;
    const listBackupsPromise = new Promise((resolve) => {
      resolveBackups = resolve;
    });

    window.electronAPI = {
      settings: {
        listBackups: jest.fn(() => listBackupsPromise)
      }
    };

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<SettingsBackupSection addNotification={jest.fn()} />);

    unmount();
    await act(async () => {
      resolveBackups({ success: true, backups: [{ path: '/tmp/a', name: 'a' }] });
      await listBackupsPromise;
    });

    const calls = consoleSpy.mock.calls.flat().join(' ');
    expect(calls).not.toMatch(/unmounted component/i);
    consoleSpy.mockRestore();
  });
});
