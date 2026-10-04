/**
 * @jest-environment jsdom
 *
 * Entity chips (U-T6, operator-approved): entities keep a DISTINCT accent
 * from the gray tag chips, but through the app's theme-scoped accent token
 * (the category-chip/ClusterLegend formula) instead of stock-Tailwind violet,
 * which never responded to data-theme.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-redux', () => ({
  useSelector: () => false
}));

import CitationPreview from '../../src/renderer/components/search/CitationPreview';

describe('CitationPreview metadata chips', () => {
  test('entity chips use the theme-scoped accent token, not violet', () => {
    render(
      <CitationPreview
        source={{ name: 'Doc.pdf', entities: ['Acme Corp'], tags: ['finance'] }}
        onOpen={jest.fn()}
      />
    );

    const entityChip = screen.getByText('Acme Corp').closest('span');
    expect(entityChip.className).toContain('text-stratosort-accent');
    expect(entityChip.className).toContain('bg-stratosort-accent/10');
    expect(entityChip.className).not.toMatch(/violet/);

    // Tag chips stay gray so the entity/tag distinction is preserved.
    const tagChip = screen.getByText('finance').closest('span');
    expect(tagChip.className).toContain('text-system-gray-600');
  });
});
