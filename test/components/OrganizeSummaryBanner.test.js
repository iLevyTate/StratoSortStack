/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import OrganizeSummaryBanner from '../../src/renderer/components/organize/OrganizeSummaryBanner';

const summaryOf = (outcome, extra = {}) => ({
  outcome,
  count: 0,
  headline: `headline for ${outcome}`,
  detail: '',
  ...extra
});

describe('OrganizeSummaryBanner', () => {
  test('a clean run is a polite status with the next-step hint', () => {
    render(<OrganizeSummaryBanner summary={summaryOf('moved')} onDismiss={jest.fn()} />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'moved');
    expect(banner).toHaveTextContent('headline for moved');
    expect(banner).toHaveTextContent(/review organized files in the status panel/i);
  });

  test('a clean run with a detail shows the detail instead of the hint', () => {
    render(
      <OrganizeSummaryBanner
        summary={summaryOf('moved', { detail: '1 identical copy was not moved.' })}
        onDismiss={jest.fn()}
      />
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('1 identical copy was not moved.');
    expect(banner).not.toHaveTextContent(/status panel/i);
  });

  test('a run that left some files behind is a status, not an interruption', () => {
    render(
      <OrganizeSummaryBanner
        summary={summaryOf('partial', { detail: 'EEXIST: destination exists' })}
        onDismiss={jest.fn()}
      />
    );

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent('EEXIST: destination exists');
  });

  test.each(['none', 'rolledBack'])('a run that moved nothing (%s) is an alert', (outcome) => {
    render(<OrganizeSummaryBanner summary={summaryOf(outcome)} onDismiss={jest.fn()} />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    expect(banner).toHaveAttribute('data-outcome', outcome);
    // No next-step hint for a run that organized nothing.
    expect(banner).not.toHaveTextContent(/status panel/i);
  });

  test('can be dismissed', () => {
    const onDismiss = jest.fn();
    render(<OrganizeSummaryBanner summary={summaryOf('partial')} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
