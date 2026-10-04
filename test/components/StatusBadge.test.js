/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import StatusBadge from '../../src/renderer/components/ui/StatusBadge';

// The suite-wide fs mock is memfs — the static source scan below must read
// the real repository tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

describe('StatusBadge', () => {
  test('tint appearance (default) keeps the original recipe', () => {
    const { container } = render(<StatusBadge variant="success">Ready</StatusBadge>);
    const badge = container.firstElementChild;
    expect(badge.tagName).toBe('DIV');
    expect(badge.className).toContain('font-medium');
    expect(badge.className).toContain('bg-stratosort-success/10');
    expect(badge.className).toContain('border-stratosort-success/50');
  });

  // U-T2: the uppercase micro-chip recipe extracted verbatim from the
  // SettingsPanel save-status / mode chips — must stay pixel-identical.
  test.each([
    ['info', 'border-stratosort-blue/30 bg-stratosort-blue/10 text-stratosort-blue'],
    ['success', 'border-stratosort-success/30 bg-stratosort-success/10 text-stratosort-success'],
    ['neutral', 'border-border-soft bg-system-gray-100 text-system-gray-500']
  ])('label appearance %s carries the verbatim chip recipe (U-T2)', (variant, tone) => {
    const { container } = render(
      <StatusBadge appearance="label" variant={variant}>
        Saving…
      </StatusBadge>
    );
    const badge = container.firstElementChild;
    expect(badge.tagName).toBe('SPAN');
    for (const cls of [
      'inline-flex',
      'items-center',
      'gap-1.5',
      'rounded-full',
      'border',
      'px-2.5',
      'py-1',
      'text-micro',
      'font-semibold',
      'uppercase',
      'tracking-wide',
      ...tone.split(' ')
    ]) {
      expect(badge.className).toContain(cls);
    }
  });

  test('SettingsPanel no longer hand-rolls the label recipe on static chips (U-T2)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/components/SettingsPanel.jsx'),
      'utf8'
    );
    const occurrences = src.match(/text-micro font-semibold uppercase tracking-wide/g) || [];
    // Exactly one raw occurrence remains: the interactive save-failed retry
    // <button> (documented in-component — StatusBadge renders a static span).
    expect(occurrences).toHaveLength(1);
    const buttonIdx = src.indexOf('Save failed — retry');
    const recipeIdx = src.indexOf('text-micro font-semibold uppercase tracking-wide');
    expect(Math.abs(buttonIdx - recipeIdx)).toBeLessThan(600);
  });
});
