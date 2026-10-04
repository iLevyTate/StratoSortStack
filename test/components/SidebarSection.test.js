/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import SidebarSection from '../../src/renderer/components/search/SidebarSection';

describe('SidebarSection', () => {
  test('open section does not clip tall children with overflow hidden', () => {
    const { container } = render(
      <SidebarSection icon={() => null} title="What's interesting" isOpen onToggle={() => {}}>
        <button type="button">Group bridge files into folder</button>
      </SidebarSection>
    );

    expect(screen.getByRole('button', { name: 'Group bridge files into folder' })).toBeVisible();

    const contentWrap = container.querySelector('section > div:last-child');
    expect(contentWrap).not.toHaveClass('overflow-hidden');
    expect(contentWrap).not.toHaveClass('max-h-0');
  });

  test('closed section hides children and uses overflow hidden', () => {
    const { container } = render(
      <SidebarSection icon={() => null} title="Add to Graph" isOpen={false} onToggle={() => {}}>
        <div>Hidden content</div>
      </SidebarSection>
    );

    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add to Graph section' }));

    const contentWrap = container.querySelector('section > div:last-child');
    expect(contentWrap).toHaveClass('overflow-hidden');
    expect(contentWrap).toHaveClass('max-h-0');
  });
});
