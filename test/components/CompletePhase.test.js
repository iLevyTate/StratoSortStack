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

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: jest.fn(() => false),
  selectOrganizedCount: jest.fn(() => 2)
}));

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
  Button: ({ children, className, onClick }) => (
    <button className={className} onClick={onClick}>
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
    const { selectOrganizedCount } = require('../../src/renderer/store/selectors');
    const defaultSelector = useAppSelector.getMockImplementation();

    const renderWithOrganized = (organizedFiles) => {
      selectRedactPaths.mockReturnValue(false);
      selectOrganizedCount.mockReturnValue(organizedFiles.length);
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
      selectOrganizedCount.mockReturnValue(2);
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
});
