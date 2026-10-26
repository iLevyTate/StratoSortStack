/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Collapsible from '../../src/renderer/components/ui/Collapsible';

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children, ...props }) => <h3 {...props}>{children}</h3>,
  Text: ({ children, ...props }) => <div {...props}>{children}</div>
}));

describe('Collapsible', () => {
  test('chevron toggles section open and closed', () => {
    const { container } = render(
      <Collapsible title="Test section" persistKey={null} defaultOpen={false}>
        <p>Hidden body</p>
      </Collapsible>
    );

    expect(screen.queryByText('Hidden body')).not.toBeInTheDocument();

    const expandBtn = screen.getByRole('button', { name: 'Expand section' });
    fireEvent.click(expandBtn);

    expect(screen.getByText('Hidden body')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse section' }));
    expect(screen.queryByText('Hidden body')).not.toBeInTheDocument();
  });

  test('title region toggles section when header is clicked (UX audit: expand affordance)', () => {
    render(
      <Collapsible title="AI bit" persistKey={null} defaultOpen={false}>
        <p>Body content</p>
      </Collapsible>
    );

    const headingBtn = screen.getByRole('button', { name: 'AI bit' });
    fireEvent.click(headingBtn);
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  test('rich titles provide the visible heading as the accessible name', () => {
    render(
      <Collapsible
        title={
          <span>
            AI <strong>Provider</strong>
          </span>
        }
        defaultOpen={false}
      >
        <p>Provider settings</p>
      </Collapsible>
    );

    const headingBtn = screen.getByRole('button', { name: 'AI Provider' });
    expect(headingBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(headingBtn);
    expect(headingBtn).toHaveAccessibleName('AI Provider');
    expect(headingBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'AI Provider' })).toContainElement(
      screen.getByText('Provider settings')
    );
  });

  test('collapsed preview toggles section when helper row is clicked', () => {
    render(
      <Collapsible title="Advanced settings" persistKey={null} defaultOpen={false}>
        <p>Settings body</p>
      </Collapsible>
    );

    expect(screen.queryByText('Settings body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Expand this section to view or edit settings.'));

    expect(screen.getByText('Settings body')).toBeInTheDocument();
  });
});
