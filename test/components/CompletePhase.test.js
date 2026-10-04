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
  RotateCcw: () => <span />,
  ArrowLeft: () => <span />,
  FolderOpen: () => <span />
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
    expect(screen.getByText(/Start over/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Review organized files|Open organized folder/i).length
    ).toBeGreaterThan(0);
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

  test('Start over cancels any pending persistence write so cleared storage stays cleared', () => {
    mockCancelPendingPersistence.mockClear();

    render(<CompletePhase />);
    fireEvent.click(screen.getByText(/Start over/i));

    expect(mockCancelPendingPersistence).toHaveBeenCalled();
  });
});
