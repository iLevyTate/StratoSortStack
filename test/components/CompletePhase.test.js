/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { selectRedactPaths } from '../../src/renderer/store/selectors';

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => jest.fn()),
  useAppSelector: jest.fn((selector) =>
    selector({
      files: {
        organizedFiles: [
          { originalName: 'invoice.pdf', path: '/dest/finance/invoice.pdf' },
          { originalName: 'notes.txt', path: '/dest/notes/notes.txt' }
        ],
        organizedPathIndex: []
      },
      analysis: {
        results: []
      }
    })
  )
}));

// The two counts are the real selectors, so each test's organized list decides them.
jest.mock('../../src/renderer/store/selectors', () => {
  const actual = jest.requireActual('../../src/renderer/store/selectors');
  return {
    selectRedactPaths: jest.fn(() => false),
    selectOrganizedCount: actual.selectOrganizedCount,
    selectMovedCount: actual.selectMovedCount
  };
});

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  setPhase: jest.fn(),
  resetUi: jest.fn()
}));

jest.mock('../../src/renderer/store/slices/filesSlice', () => ({
  resetFilesState: jest.fn()
}));

jest.mock('../../src/renderer/store/slices/analysisSlice', () => ({
  resetAnalysisState: jest.fn()
}));

const mockCancelPendingPersistence = jest.fn();
jest.mock('../../src/renderer/store/middleware/persistenceMiddleware', () => ({
  cancelPendingPersistence: (...args) => mockCancelPendingPersistence(...args)
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, className, onClick, 'aria-label': ariaLabel }) => (
    <button className={className} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  Card: ({ children, className }) => <div className={className}>{children}</div>,
  StatusBadge: ({ children }) => <div>{children}</div>,
  MinimizableGuideCard: ({ children, collapsedSummary }) => {
    const React = require('react');
    const [isOpen, setIsOpen] = React.useState(true);

    return isOpen ? (
      <div>
        <button aria-label="Minimize guide" onClick={() => setIsOpen(false)} type="button">
          Minimize
        </button>
        {children}
      </div>
    ) : (
      <div>
        {collapsedSummary}
        <button aria-label="Expand guide" onClick={() => setIsOpen(true)} type="button">
          Expand
        </button>
      </div>
    );
  }
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ children, className }) => <h1 className={className}>{children}</h1>,
  Text: ({ children, className }) => <span className={className}>{children}</span>
}));

jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  UndoRedoToolbar: () => <div>UNDO_REDO</div>
}));

jest.mock('../../src/renderer/components/layout', () => ({
  ActionBar: ({ children }) => <div>{children}</div>,
  Inline: ({ children, className }) => <div className={className}>{children}</div>,
  Stack: ({ children, className }) => <div className={className}>{children}</div>
}));

jest.mock('../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayPath: jest.fn((value) => value),
  formatDisplayFileName: jest.fn((value, options = {}) =>
    options.redact
      ? `Hidden file${value?.includes('.') ? value.slice(value.lastIndexOf('.')) : ''}`
      : value
  )
}));

jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, className }) => <div className={className}>{children}</div>
  },
  useReducedMotion: jest.fn(() => true)
}));

jest.mock('lucide-react', () => ({
  CheckCircle2: () => <span />,
  Check: () => <span />,
  Copy: () => <span />,
  FilePlus: () => <span />,
  ArrowLeft: () => <span />,
  FolderOpen: () => <span />
}));

const mockRevealFile = jest.fn();
jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({ revealFile: mockRevealFile })
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showError: jest.fn(),
    showInfo: jest.fn(),
    showSuccess: jest.fn(),
    showWarning: jest.fn()
  })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: {
    openFolder: jest.fn().mockResolvedValue(undefined)
  }
}));

import CompletePhase from '../../src/renderer/phases/CompletePhase';

describe('CompletePhase premium finish', () => {
  test('renders premium completion framing and refined next-step copy', () => {
    render(<CompletePhase />);

    expect(screen.getByText(/Step 5 of 5/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Session summary/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Analyze more files/i)).toBeInTheDocument();
    expect(screen.getByText(/Review organized files/i)).toBeInTheDocument();
  });

  test('allows the top completion card to be minimized', () => {
    render(<CompletePhase />);

    expect(screen.getByText(/A clean finish for this batch/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /minimize .*guide/i }));

    expect(screen.queryByText(/A clean finish for this batch/i)).not.toBeInTheDocument();
    expect(screen.getByText(/2 files moved into 2 destinations\./i)).toBeInTheDocument();
  });

  test('redacts organized file names when privacy redaction is enabled', () => {
    selectRedactPaths.mockReturnValue(true);

    render(<CompletePhase />);

    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
    expect(screen.getByText('Hidden file.pdf')).toBeInTheDocument();
    expect(screen.getByText('Hidden file.txt')).toBeInTheDocument();
    expect(screen.getAllByText(/Destination hidden/i).length).toBeGreaterThan(0);
  });

  test('Analyze more files cancels any pending persistence write so cleared storage stays cleared', () => {
    mockCancelPendingPersistence.mockClear();

    render(<CompletePhase />);
    fireEvent.click(screen.getByText(/Analyze more files/i));

    expect(mockCancelPendingPersistence).toHaveBeenCalled();
  });

  test('Analyze more files clears the batch and lands on Discover, not Welcome', () => {
    const { setPhase, resetUi } = require('../../src/renderer/store/slices/uiSlice');
    setPhase.mockClear();
    resetUi.mockClear();

    render(<CompletePhase />);
    fireEvent.click(screen.getByText(/Analyze more files/i));

    expect(resetUi).toHaveBeenCalled();
    expect(setPhase).toHaveBeenCalledWith('discover');
  });

  test('the open-folder button names the folder it opens', () => {
    selectRedactPaths.mockReturnValue(false);
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const defaultSelector = useAppSelector.getMockImplementation();
    useAppSelector.mockImplementation((selector) =>
      selector({
        files: {
          organizedFiles: [
            { originalName: 'a.pdf', path: 'C:\\Docs\\Finance\\a.pdf' },
            { originalName: 'b.pdf', path: 'C:\\Docs\\Finance\\b.pdf' }
          ],
          organizedPathIndex: []
        },
        analysis: { results: [] }
      })
    );
    try {
      render(<CompletePhase />);
      expect(screen.getByText('Open Finance')).toBeInTheDocument();
      expect(screen.queryByText(/Open organized folder/i)).not.toBeInTheDocument();
    } finally {
      useAppSelector.mockImplementation(defaultSelector);
    }
  });

  test('a renamed file shows its new name and folder, and can be shown in its folder', () => {
    selectRedactPaths.mockReturnValue(false);
    mockRevealFile.mockClear();
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const defaultSelector = useAppSelector.getMockImplementation();
    useAppSelector.mockImplementation((selector) =>
      selector({
        files: {
          organizedFiles: [
            {
              originalName: 'Tiller Template (3).xlsx',
              path: 'C:\\Docs\\Finance\\transaction-log.xlsx'
            }
          ],
          organizedPathIndex: []
        },
        analysis: { results: [] }
      })
    );
    try {
      render(<CompletePhase />);
      expect(
        screen.getByText('Renamed to transaction-log.xlsx · in C:\\Docs\\Finance')
      ).toBeInTheDocument();
      const row = screen.getByLabelText('Organized file 1');
      fireEvent.click(row.querySelector('button'));
      expect(mockRevealFile).toHaveBeenCalledWith('C:\\Docs\\Finance\\transaction-log.xlsx');
    } finally {
      useAppSelector.mockImplementation(defaultSelector);
    }
  });

  describe('counts in the summary', () => {
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const defaultSelector = useAppSelector.getMockImplementation();

    const renderWithOrganized = (organizedFiles) => {
      selectRedactPaths.mockReturnValue(false);
      useAppSelector.mockImplementation((selector) =>
        selector({
          files: { organizedFiles, organizedPathIndex: [] },
          analysis: { results: [] }
        })
      );
      render(<CompletePhase />);
    };

    afterEach(() => {
      useAppSelector.mockImplementation(defaultSelector);
    });

    test('counts destination folders, not one destination per file', () => {
      renderWithOrganized([
        { originalName: 'a.pdf', path: 'C:\\Docs\\Finance\\a.pdf', smartFolder: 'Finance' },
        { originalName: 'b.pdf', path: 'c:/docs/finance/b.pdf', smartFolder: 'Finance' },
        { originalName: 'c.txt', path: 'C:\\Docs\\Notes\\c.txt', smartFolder: 'Notes' }
      ]);

      expect(screen.getByText('3 files moved into 2 destinations.')).toBeInTheDocument();
      expect(screen.getByText('2 destinations')).toBeInTheDocument();
    });

    test('files in one folder are one destination, with no destinations badge', () => {
      renderWithOrganized([
        { originalName: 'a.pdf', path: '/dest/finance/a.pdf', smartFolder: 'finance' },
        { originalName: 'b.pdf', path: '/dest/finance/b.pdf', smartFolder: 'finance' }
      ]);

      expect(screen.getByText('2 files moved into 1 destination.')).toBeInTheDocument();
      expect(screen.queryByText(/\d+ destinations$/)).not.toBeInTheDocument();
    });

    test('a single organized file reads "1 file is now in place"', () => {
      renderWithOrganized([
        { originalName: 'a.pdf', path: '/dest/finance/a.pdf', smartFolder: 'finance' }
      ]);

      expect(
        screen.getByText('Your reviewed batch is complete. 1 file is now in place.')
      ).toBeInTheDocument();
    });

    test('several organized files read "are now in place"', () => {
      renderWithOrganized([
        { originalName: 'a.pdf', path: '/dest/finance/a.pdf', smartFolder: 'finance' },
        { originalName: 'b.pdf', path: '/dest/finance/b.pdf', smartFolder: 'finance' }
      ]);

      expect(
        screen.getByText('Your reviewed batch is complete. 2 files are now in place.')
      ).toBeInTheDocument();
    });
  });

  // A file whose destination already held an identical copy is removed, not
  // moved. `path` on its entry is the copy that was kept.
  describe('duplicates that were removed instead of moved', () => {
    const { useAppSelector } = require('../../src/renderer/store/hooks');
    const defaultSelector = useAppSelector.getMockImplementation();

    const movedFile = {
      originalName: 'report.pdf',
      path: 'C:\\Docs\\Finance\\report.pdf',
      smartFolder: 'Finance'
    };
    const duplicateOf = (name, duplicateRemoval = 'trashed') => ({
      originalName: name,
      path: 'C:\\Docs\\Archive\\report.pdf',
      smartFolder: 'Archive',
      duplicateRemoval
    });

    const renderWithOrganized = (organizedFiles, { redact = false } = {}) => {
      selectRedactPaths.mockReturnValue(redact);
      useAppSelector.mockImplementation((selector) =>
        selector({
          files: { organizedFiles, organizedPathIndex: [] },
          analysis: { results: [] }
        })
      );
      render(<CompletePhase />);
    };

    afterEach(() => {
      useAppSelector.mockImplementation(defaultSelector);
      selectRedactPaths.mockReturnValue(false);
    });

    test('are not counted as moved files or as destinations', () => {
      renderWithOrganized([movedFile, duplicateOf('report (1).pdf')]);

      expect(
        screen.getByText(
          '1 file moved into 1 destination. 1 identical copy was removed instead of moved.'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText('Your reviewed batch is complete. 1 file is now in place.')
      ).toBeInTheDocument();
      expect(screen.getByText('1 file organized, 1 duplicate removed')).toBeInTheDocument();
      expect(screen.queryByText(/\d+ destinations$/)).not.toBeInTheDocument();
    });

    test('the row says the file was not moved and where its copy went', () => {
      mockRevealFile.mockClear();
      renderWithOrganized([movedFile, duplicateOf('report (1).pdf')]);

      expect(
        screen.getByText(
          'Not moved: an identical copy is already in C:\\Docs\\Archive. This copy is in the system Trash.'
        )
      ).toBeInTheDocument();
      const reveal = screen.getByRole('button', {
        name: 'Show the kept copy of report (1).pdf in its folder'
      });
      fireEvent.click(reveal);
      expect(mockRevealFile).toHaveBeenCalledWith('C:\\Docs\\Archive\\report.pdf');
    });

    test('a copy that did not go to the Trash is reported as removed', () => {
      renderWithOrganized([movedFile, duplicateOf('report (1).pdf', 'deleted')]);

      expect(screen.getByText(/This copy was removed\.$/)).toBeInTheDocument();
      expect(screen.queryByText(/system Trash/)).not.toBeInTheDocument();
    });

    test('a session of nothing but duplicates does not claim a move', () => {
      renderWithOrganized([duplicateOf('report (1).pdf'), duplicateOf('report (2).pdf')]);

      expect(
        screen.getByText(
          'No files needed moving. 2 identical copies were removed instead of moved.'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your reviewed batch is complete. Every file already had an identical copy in its destination folder.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/files? moved$/)).not.toBeInTheDocument();
      expect(screen.getByText('2 duplicates removed', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByText(/0 files/)).not.toBeInTheDocument();
    });

    test('the destination stays hidden when privacy redaction is on', () => {
      renderWithOrganized([duplicateOf('report (1).pdf')], { redact: true });

      expect(
        screen.getByText(
          'Not moved: an identical copy is already in the destination. This copy is in the system Trash.'
        )
      ).toBeInTheDocument();
    });
  });
});
