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

  describe('completion flash', () => {
    const finishRun = (lastProgress, extraProps = {}) => {
      const { rerender } = render(
        <OrganizeProgress isOrganizing batchProgress={{ ...lastProgress, currentFile: '' }} />
      );
      rerender(
        <OrganizeProgress
          isOrganizing={false}
          batchProgress={{ current: 0, total: 0, currentFile: '' }}
          {...extraProps}
        />
      );
    };

    test('counts the files that were organized, not every file the run touched', () => {
      finishRun({ current: 10, total: 10 }, { organizedCount: 7 });

      expect(screen.getByText('Done!')).toBeTruthy();
      expect(screen.getByText('Organized 7 files.')).toBeTruthy();
      expect(screen.queryByText(/Organized 10 files/)).toBeNull();
    });

    test('without an organized count it only claims the files were processed', () => {
      finishRun({ current: 10, total: 10 });

      expect(screen.getByText('Processed 10 files.')).toBeTruthy();
      expect(screen.queryByText(/Organized 10 files/)).toBeNull();
    });

    test('a run that stopped short of the total shows no "Done!"', () => {
      finishRun({ current: 4, total: 10 }, { organizedCount: 4 });

      expect(screen.queryByText(/done!/i)).toBeNull();
    });
  });

  describe('planned operations list', () => {
    // The name can also appear in the "now moving" line above the list.
    const rowFor = (name) =>
      screen
        .getAllByText(name)
        .map((el) => el.closest('.rounded-lg'))
        .find(Boolean);

    test('highlights the row being moved when the file is renamed on the way', () => {
      render(
        <OrganizeProgress
          isOrganizing
          batchProgress={{ current: 0, total: 2, currentFile: 'scan001.pdf' }}
          preview={[
            {
              fileName: 'Invoice 2026.pdf',
              sourcePath: 'C:\\in\\scan001.pdf',
              destination: 'C:\\Docs\\Finance\\Invoice 2026.pdf'
            },
            {
              fileName: 'Notes.txt',
              sourcePath: '/in/scan002.txt',
              destination: '/Docs/Notes/Notes.txt'
            }
          ]}
        />
      );

      expect(rowFor('Invoice 2026.pdf').className).toContain('bg-stratosort-blue/10');
      expect(rowFor('Notes.txt').className).not.toContain('bg-stratosort-blue/10');
    });

    test('does not highlight a row whose new name equals another file’s original name', () => {
      render(
        <OrganizeProgress
          isOrganizing
          batchProgress={{ current: 0, total: 2, currentFile: 'report.pdf' }}
          preview={[
            {
              fileName: 'report.pdf',
              sourcePath: '/in/draft.pdf',
              destination: '/Docs/A/report.pdf'
            }
          ]}
        />
      );

      expect(rowFor('report.pdf').className).not.toContain('bg-stratosort-blue/10');
    });
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
