/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import AppShell from '../../src/renderer/components/layout/AppShell';

describe('AppShell scroll regression guards', () => {
  test('keeps main-content as the dedicated scroll container', () => {
    render(
      <AppShell
        header={<div>HEADER</div>}
        subheader={<div>SUBHEADER</div>}
        footer={<div>FOOTER</div>}
      >
        <div>CONTENT</div>
      </AppShell>
    );

    const main = document.getElementById('main-content');
    expect(main).toBeInTheDocument();
    expect(main).toHaveClass('overflow-y-auto');
    expect(main).toHaveClass('overflow-x-hidden');
    expect(main).toHaveClass('modern-scrollbar');
    expect(main.getAttribute('style') || '').not.toMatch(/scrollbar-gutter/i);

    expect(screen.getByText('HEADER')).toBeInTheDocument();
    expect(screen.getByText('SUBHEADER')).toBeInTheDocument();
    expect(screen.getByText('CONTENT')).toBeInTheDocument();
    expect(screen.getByText('FOOTER')).toBeInTheDocument();
  });

  test('exposes a focusable #main-content landmark for assistive tech', () => {
    // NOTE: the visible "Skip to main content" link was removed in the
    // 2026-05 navigation cleanup. The focusable <main> landmark alone
    // covers screen-reader users but is NOT a WCAG 2.4.1 (Bypass Blocks)
    // substitute for keyboard-only users — see PR description for the
    // accessibility regression context. If the skip link is reintroduced,
    // restore the skip-link assertions below.
    render(
      <AppShell header={<a href="#nav-item">NAV</a>}>
        <div>CONTENT</div>
      </AppShell>
    );

    const main = document.getElementById('main-content');
    expect(main).toBeInTheDocument();
    // The main landmark must remain programmatically focusable so
    // assistive tech can move focus to content after skipping nav.
    expect(main).toHaveAttribute('tabIndex', '-1');
  });

  test('applies explicit content container classes without breaking children rendering', () => {
    render(
      <AppShell contentClassName="custom-content-shell">
        <div>ONLY_CONTENT</div>
      </AppShell>
    );

    const content = screen.getByText('ONLY_CONTENT');
    expect(content).toBeInTheDocument();
    expect(content.parentElement).toHaveClass('custom-content-shell');
  });
});
