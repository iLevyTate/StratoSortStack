/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import Spinner from '../../src/renderer/components/ui/Spinner';

// The suite-wide fs mock is memfs — the static source scan below must read
// the real repository tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

describe('Spinner (U-T10)', () => {
  test.each([
    ['xs', 'w-5 h-5 border-2'],
    ['md', 'w-10 h-10 border-3'],
    ['lg', 'w-12 h-12 border-4']
  ])('%s size renders the canonical ring recipe', (size, expected) => {
    const { container } = render(<Spinner size={size} />);
    const ring = container.firstElementChild;
    for (const cls of [
      'animate-spin',
      'rounded-full',
      'border-stratosort-blue',
      'border-t-transparent',
      ...expected.split(' ')
    ]) {
      expect(ring.className).toContain(cls);
    }
  });

  test('decorative by default; label exposes a status role instead', () => {
    const { container: plain } = render(<Spinner />);
    expect(plain.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(plain.firstElementChild).not.toHaveAttribute('role');

    const { container: labeled } = render(<Spinner label="Loading chats" />);
    expect(labeled.firstElementChild).toHaveAttribute('role', 'status');
    expect(labeled.firstElementChild).toHaveAttribute('aria-label', 'Loading chats');
    expect(labeled.firstElementChild).not.toHaveAttribute('aria-hidden');
  });

  // Ratchet: the files converted to the primitive must not regress to
  // hand-rolled ring spinners (animate-spin + rounded-full on one element).
  test('adopted files contain no hand-rolled ring spinners', () => {
    const rendererRoot = path.join(__dirname, '../../src/renderer');
    const adopted = [
      'components/AnalysisHistoryModal.jsx',
      'components/SettingsPanel.jsx',
      'components/search/ConversationSidebar.jsx',
      'components/ui/LoadingSkeleton.jsx'
    ];
    for (const rel of adopted) {
      const src = fs.readFileSync(path.join(rendererRoot, rel), 'utf8');
      const rawRings = src
        .split('\n')
        .filter((line) => line.includes('animate-spin') && line.includes('rounded-full'))
        .map((line) => line.trim());
      expect({ file: rel, rawRings }).toEqual({ file: rel, rawRings: [] });
    }
  });
});
