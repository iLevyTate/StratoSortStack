/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AutoOrganizeSection from '../../src/renderer/components/settings/AutoOrganizeSection';

function renderWith(settings) {
  const setSettings = jest.fn();
  render(<AutoOrganizeSection settings={settings} setSettings={setSettings} />);
  return setSettings;
}

describe('AutoOrganizeSection smart-folder watching switch', () => {
  test('is on by default (matches DEFAULT_SETTINGS)', () => {
    renderWith({});
    expect(screen.getByRole('switch', { name: 'Toggle smart folder watching' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('reflects an explicit opt-out and writes the change back', () => {
    const setSettings = renderWith({ smartFolderWatchEnabled: false });
    const sw = screen.getByRole('switch', { name: 'Toggle smart folder watching' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(setSettings).toHaveBeenCalledTimes(1);
    const updater = setSettings.mock.calls[0][0];
    expect(updater({ smartFolderWatchEnabled: false })).toEqual({
      smartFolderWatchEnabled: true
    });
  });
});
