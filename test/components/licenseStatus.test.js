/**
 * @jest-environment jsdom
 *
 * Renderer half of the commercial license status. The public release has no
 * trial and no gate: the slice starts at `free`, nothing reads it to decide
 * whether a feature runs, and Settings only reports what the key says.
 */
'use strict';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import '@testing-library/jest-dom';

import licenseReducer, {
  fetchLicenseStatus,
  selectLicenseSnapshot
} from '../../src/renderer/store/slices/licenseSlice';
import * as licenseSlice from '../../src/renderer/store/slices/licenseSlice';
import uiReducer from '../../src/renderer/store/slices/uiSlice';
import LicenseSection from '../../src/renderer/components/settings/LicenseSection';

function makeStore(snapshot) {
  const store = configureStore({
    reducer: { license: licenseReducer, ui: uiReducer }
  });
  if (snapshot) {
    store.dispatch({
      type: fetchLicenseStatus.fulfilled.type,
      payload: { success: true, snapshot }
    });
  }
  return store;
}

const SNAPSHOTS = {
  free: { state: 'free' },
  licensed: {
    state: 'licensed',
    name: 'Ada Lovelace',
    edition: 'commercial',
    maintenanceUntil: '2027-07-03'
  },
  notCovered: {
    state: 'version_not_covered',
    name: 'Ada Lovelace',
    maintenanceUntil: '2027-07-03',
    buildDate: '2027-08-01'
  }
};

describe('licenseSlice', () => {
  test('starts as free before the first fetch resolves', () => {
    expect(selectLicenseSnapshot(makeStore().getState()).state).toBe('free');
  });

  test('exports no AI-action gate for components to consult', () => {
    expect(licenseSlice.selectCanRunAiActions).toBeUndefined();
    expect(licenseSlice.isAiActionBlocked).toBeUndefined();
    expect(licenseSlice.attestPersonalUse).toBeUndefined();
  });
});

describe('LicenseSection', () => {
  function renderSection(snapshot) {
    const store = makeStore(snapshot);
    render(
      <Provider store={store}>
        <LicenseSection />
      </Provider>
    );
    return store;
  }

  test('free state says nothing is locked and has no trial or attestation copy', () => {
    renderSection(SNAPSHOTS.free);
    expect(screen.getByText('Free for personal use')).toBeInTheDocument();
    expect(screen.getByText(/Every feature works without a key/)).toBeInTheDocument();
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/days? remaining/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: "I'm using this personally" })
    ).not.toBeInTheDocument();
  });

  test('free state offers key entry; Activate disabled until a key is pasted', () => {
    renderSection(SNAPSHOTS.free);
    const activate = screen.getByRole('button', { name: 'Activate' });
    expect(activate).toBeDisabled();
    fireEvent.change(screen.getByLabelText('License key'), {
      target: { value: 'SSORT1-somekeybody.signature' }
    });
    expect(activate).toBeEnabled();
  });

  test('an unknown state from an older snapshot renders as free', () => {
    renderSection({ state: 'trial_expired', daysLeft: 0 });
    expect(screen.getByText('Free for personal use')).toBeInTheDocument();
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument();
  });

  test('licensed state shows the licensee and a deactivate affordance', () => {
    renderSection(SNAPSHOTS.licensed);
    expect(screen.getByText(/Licensed to Ada Lovelace/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove license from this device' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('License key')).not.toBeInTheDocument();
  });

  test('version_not_covered is a notice about the update window', () => {
    renderSection(SNAPSHOTS.notCovered);
    expect(screen.getByText('Update not covered')).toBeInTheDocument();
    expect(screen.getByText(/update window/)).toBeInTheDocument();
  });

  test('activation copy promises offline verification', () => {
    renderSection(SNAPSHOTS.free);
    expect(screen.getByText(/verified entirely on this device/)).toBeInTheDocument();
  });

  // Purchase is email-only (docs/COMMERCIAL.md). The app must offer that
  // route wherever it asks for a key, or "enter a commercial key" is a dead end.
  test.each(['free', 'notCovered'])('%s state offers a way to buy a commercial license', (name) => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    try {
      renderSection(SNAPSHOTS[name]);
      fireEvent.click(screen.getByRole('button', { name: 'Buy a commercial license' }));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy.mock.calls[0][0]).toMatch(/^mailto:contact@kennedyappliedsciences\.com\?/);
    } finally {
      openSpy.mockRestore();
    }
  });

  test('licensed state does not nag about buying', () => {
    renderSection(SNAPSHOTS.licensed);
    expect(
      screen.queryByRole('button', { name: 'Buy a commercial license' })
    ).not.toBeInTheDocument();
  });
});
