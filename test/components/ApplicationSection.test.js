/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));
jest.mock('../../src/renderer/components/ui/Switch', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/shared/logger', () => ({
  logger: { error: jest.fn() }
}));

import ApplicationSection from '../../src/renderer/components/settings/ApplicationSection';

function renderWithCheckResult(checkForUpdates) {
  window.electronAPI = { system: { checkForUpdates } };
  const addNotification = jest.fn();
  const utils = render(
    <ApplicationSection settings={{}} setSettings={jest.fn()} addNotification={addNotification} />
  );
  fireEvent.click(utils.getByRole('button', { name: 'Check for application updates' }));
  return { addNotification };
}

describe('ApplicationSection: Check for updates', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  test('a copy that cannot update itself shows the reason instead of an error', async () => {
    const reason =
      'This copy was not installed with the StratoSort Stack installer (for example, it was ' +
      'extracted from the zip), so it cannot update itself.';
    const { addNotification } = renderWithCheckResult(
      jest.fn(async () => ({ success: true, unsupported: true, reason }))
    );

    await waitFor(() => expect(addNotification).toHaveBeenCalledWith(reason, 'warning'));
    expect(addNotification).not.toHaveBeenCalledWith('Failed to check for updates', 'error');
  });

  test('disabled update checks say so', async () => {
    const { addNotification } = renderWithCheckResult(
      jest.fn(async () => ({ success: true, disabled: true }))
    );

    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith(
        'Update checks are temporarily disabled in this build.',
        'info'
      )
    );
  });

  test('a started check reports that it is checking', async () => {
    const { addNotification } = renderWithCheckResult(jest.fn(async () => ({ success: true })));

    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith('Checking for updates…', 'info')
    );
  });

  test('a failed check still reports a failure', async () => {
    const { addNotification } = renderWithCheckResult(
      jest.fn(async () => ({ success: false, error: 'offline' }))
    );

    await waitFor(() =>
      expect(addNotification).toHaveBeenCalledWith('Failed to check for updates', 'error')
    );
  });
});
