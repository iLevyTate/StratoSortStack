/**
 * @jest-environment jsdom
 *
 * SearchErrorBoundary fallback (U-011) — the error overlay must be a real
 * modal alertdialog: labeled, aria-modal, Escape closes it.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import SearchErrorBoundary from '../../src/renderer/components/search/SearchErrorBoundary';

let shouldThrow = true;
function Boom() {
  if (shouldThrow) throw new Error('boom');
  return <div>recovered</div>;
}

describe('SearchErrorBoundary fallback dialog', () => {
  let consoleError;

  beforeEach(() => {
    shouldThrow = true;
    // React logs caught boundary errors via console.error; silence them so
    // the global unexpected-console filter does not fail the suite.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('fallback renders as a labeled modal alertdialog', () => {
    render(
      <SearchErrorBoundary>
        <Boom />
      </SearchErrorBoundary>
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/search encountered an error/i);
  });

  test('Escape closes the fallback and fires onClose', () => {
    const onClose = jest.fn();
    render(
      <SearchErrorBoundary onClose={onClose}>
        <Boom />
      </SearchErrorBoundary>
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  test('Try Again re-renders children', () => {
    render(
      <SearchErrorBoundary>
        <Boom />
      </SearchErrorBoundary>
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
