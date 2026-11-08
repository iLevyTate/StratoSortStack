/**
 * @jest-environment jsdom
 *
 * import-extraction-4: when the analysis saw only part of a file (the head of
 * an oversize text file, the first pages of a long scan, a body cut at the
 * extractor's cap) the result carries partialContent: true. The details view
 * must say so next to the extraction method instead of presenting a partial
 * read as the whole document.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Card', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, className }) => <div className={className}>{children}</div>
  };
});
jest.mock('../../src/renderer/components/ui/Collapsible', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ title, children }) => (
      <section>
        {title}
        {children}
      </section>
    )
  };
});
jest.mock('../../src/renderer/components/ui/StatusBadge', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children }) => <span>{children}</span>
  };
});
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));

import AnalysisDetails from '../../src/renderer/components/AnalysisDetails';

describe('AnalysisDetails — partial content', () => {
  test('marks the Method row when only part of the file was read', () => {
    render(
      <AnalysisDetails
        analysis={{ category: 'Reports', extractionMethod: 'content', partialContent: true }}
      />
    );
    const methodLabel = screen.getByText('Method');
    const methodRow = methodLabel.parentElement;
    expect(methodRow).toHaveTextContent(/content/);
    expect(methodRow).toHaveTextContent(/partial/i);
  });

  test('a complete read shows the plain method with no partial note', () => {
    render(<AnalysisDetails analysis={{ category: 'Reports', extractionMethod: 'content' }} />);
    const methodRow = screen.getByText('Method').parentElement;
    expect(methodRow).toHaveTextContent('content');
    expect(methodRow).not.toHaveTextContent(/partial/i);
  });
});
