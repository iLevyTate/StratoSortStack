/**
 * @jest-environment jsdom
 *
 * UX-4 oracles for OrganizeProgress: pause/resume controls and the paused
 * banner, plus the no-completion-flash guarantee for cancelled/paused runs.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('react-redux', () => ({
  useSelector: jest.fn(() => false)
}));

jest.mock('../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayPath: jest.fn((p) => p)
}));

import OrganizeProgress from '../../src/renderer/components/organize/OrganizeProgress';

describe('OrganizeProgress pause/resume (UX-4)', () => {
  test('shows a Pause button while organizing when onPause is provided', () => {
    render(
      <OrganizeProgress
        isOrganizing
        batchProgress={{ current: 1, total: 3, currentFile: '/a.txt' }}
        onCancel={jest.fn()}
        onPause={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /pause organize batch/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel organize batch/i })).toBeTruthy();
  });

  test('clicking Pause invokes onPause and disables while pausing', () => {
    const onPause = jest.fn();
    const { rerender } = render(
      <OrganizeProgress
        isOrganizing
        batchProgress={{ current: 1, total: 3, currentFile: '/a.txt' }}
        onPause={onPause}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /pause organize batch/i }));
    expect(onPause).toHaveBeenCalledTimes(1);

    rerender(
      <OrganizeProgress
        isOrganizing
        batchProgress={{ current: 1, total: 3, currentFile: '/a.txt' }}
        onPause={onPause}
        isPausing
      />
    );
    expect(screen.getByRole('button', { name: /pausing organize batch/i })).toHaveProperty(
      'disabled',
      true
    );
  });

  test('paused state renders a banner with counts and a working Resume button', () => {
    const onResume = jest.fn();
    render(
      <OrganizeProgress
        isOrganizing={false}
        batchProgress={{ current: 0, total: 0, currentFile: '' }}
        isPaused
        pausedSummary={{ completed: 2, remaining: 3 }}
        onResume={onResume}
        onDismissPaused={jest.fn()}
      />
    );

    expect(screen.getByText(/paused/i)).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy();
    const resume = screen.getByRole('button', { name: /resume organize batch/i });
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test('paused state never shows the completion flash ("Done!")', () => {
    render(
      <OrganizeProgress
        isOrganizing={false}
        batchProgress={{ current: 0, total: 0, currentFile: '' }}
        isPaused
        pausedSummary={{ completed: 2, remaining: 3 }}
        onResume={jest.fn()}
      />
    );

    expect(screen.queryByText(/done!/i)).toBeNull();
  });

  test('renders nothing when neither organizing nor paused', () => {
    const { container } = render(
      <OrganizeProgress
        isOrganizing={false}
        batchProgress={{ current: 0, total: 0, currentFile: '' }}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
