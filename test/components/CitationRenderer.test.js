/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import CitationRenderer from '../../src/renderer/components/search/CitationRenderer';

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

jest.mock('../../src/renderer/components/ui', () => {
  const React = require('react');
  return {
    Button: ({ children, onClick, ...rest }) => (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    )
  };
});

describe('CitationRenderer', () => {
  test('renders [?] placeholder when doc id is not in sources (hallucination)', () => {
    render(
      <CitationRenderer
        text="See [doc-9] for details"
        sources={[{ id: 'doc-1', name: 'Only one doc' }]}
        onOpenSource={jest.fn()}
      />
    );
    expect(screen.getByText('[?]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Citation 9/ })).not.toBeInTheDocument();
  });

  test('renders citation button when source exists', () => {
    render(
      <CitationRenderer
        text="Ref [doc-1] here"
        sources={[{ id: 'doc-1', name: 'My Doc' }]}
        onOpenSource={jest.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Citation 1/ })).toBeInTheDocument();
    expect(screen.queryByText('[?]')).not.toBeInTheDocument();
  });
});
