/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DebugToolsSection from '../../src/renderer/components/settings/DebugToolsSection';
import { DEBUG_STORAGE_KEYS } from '../../src/renderer/utils/debugFlags';

describe('DebugToolsSection', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    window.localStorage.clear();
  });

  test('does not render outside development builds', () => {
    process.env.NODE_ENV = 'production';

    const { container } = render(
      <DebugToolsSection settings={{ developerGraphEnabled: true }} setSettings={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('updates persisted graph visibility setting', () => {
    process.env.NODE_ENV = 'development';
    const setSettings = jest.fn();
    const addNotification = jest.fn();

    render(
      <DebugToolsSection
        settings={{ developerGraphEnabled: true }}
        setSettings={setSettings}
        addNotification={addNotification}
      />
    );

    fireEvent.click(screen.getAllByRole('switch')[0]);

    expect(setSettings).toHaveBeenCalledWith(expect.any(Function));
    const updater = setSettings.mock.calls[0][0];
    expect(updater({ developerGraphEnabled: true })).toEqual({ developerGraphEnabled: false });
    expect(addNotification).toHaveBeenCalledWith(
      'Graph view hidden. Search and chat remain available.',
      'info'
    );
  });

  test('enables debug mode and wizard force flags', () => {
    process.env.NODE_ENV = 'development';
    const addNotification = jest.fn();

    render(
      <DebugToolsSection
        settings={{ developerGraphEnabled: true }}
        setSettings={jest.fn()}
        addNotification={addNotification}
      />
    );

    let switches = screen.getAllByRole('switch');
    const debugSwitch = switches[1];
    expect(switches[2]).toBeDisabled();

    fireEvent.click(debugSwitch);
    expect(window.localStorage.getItem(DEBUG_STORAGE_KEYS.debugMode)).toBe('1');

    switches = screen.getAllByRole('switch');
    const forceWizardSwitch = switches[2];
    expect(forceWizardSwitch).not.toBeDisabled();

    fireEvent.click(forceWizardSwitch);
    expect(window.localStorage.getItem(DEBUG_STORAGE_KEYS.forceModelWizard)).toBe('1');
    expect(addNotification).toHaveBeenCalled();
  });

  test('disabling debug mode clears force wizard flag', () => {
    process.env.NODE_ENV = 'development';
    window.localStorage.setItem(DEBUG_STORAGE_KEYS.debugMode, '1');
    window.localStorage.setItem(DEBUG_STORAGE_KEYS.forceModelWizard, '1');

    render(
      <DebugToolsSection settings={{ developerGraphEnabled: true }} setSettings={jest.fn()} />
    );
    const switches = screen.getAllByRole('switch');

    fireEvent.click(switches[1]);

    expect(window.localStorage.getItem(DEBUG_STORAGE_KEYS.debugMode)).toBeNull();
    expect(window.localStorage.getItem(DEBUG_STORAGE_KEYS.forceModelWizard)).toBeNull();
  });
});
