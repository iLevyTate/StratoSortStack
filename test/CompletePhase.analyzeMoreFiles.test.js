/**
 * @jest-environment jsdom
 *
 * The analysis run lives above the phases, so the user can reach Complete
 * while later files are still analyzing. "Analyze more files" used to clear
 * only Redux: the run kept going unseen, with no progress card or Stop
 * button, and the next files were queued behind it. It now resets the run
 * itself before clearing the batch.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockCalls = [];

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: () => (action) => mockCalls.push(action),
  useAppSelector: (selector) =>
    selector({
      files: {
        organizedFiles: [{ originalName: 'invoice.pdf', path: '/dest/finance/invoice.pdf' }],
        organizedPathIndex: []
      },
      analysis: { results: [] }
    })
}));

jest.mock('../src/renderer/store/selectors', () => {
  const actual = jest.requireActual('../src/renderer/store/selectors');
  return {
    selectRedactPaths: () => false,
    selectOrganizedCount: actual.selectOrganizedCount,
    selectMovedCount: actual.selectMovedCount
  };
});

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  setPhase: (phase) => `setPhase:${phase}`,
  resetUi: () => 'resetUi'
}));
jest.mock('../src/renderer/store/slices/filesSlice', () => ({
  resetFilesState: () => 'resetFilesState'
}));
jest.mock('../src/renderer/store/slices/analysisSlice', () => ({
  resetAnalysisState: () => 'resetAnalysisState'
}));
jest.mock('../src/renderer/store/middleware/persistenceMiddleware', () => ({
  cancelPendingPersistence: jest.fn()
}));

const mockResetRun = jest.fn((reason) => mockCalls.push(`resetRun:${reason}`));
jest.mock('../src/renderer/phases/discover/AnalysisRunProvider', () => ({
  useAnalysisRun: () => ({ resetRun: mockResetRun })
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  UndoRedoToolbar: () => null
}));
jest.mock('framer-motion', () => ({
  motion: { div: ({ children, className }) => <div className={className}>{children}</div> },
  useReducedMotion: () => true
}));
jest.mock('../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({ revealFile: jest.fn() })
}));
jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showError: jest.fn(),
    showInfo: jest.fn(),
    showSuccess: jest.fn(),
    showWarning: jest.fn()
  })
}));
jest.mock('../src/renderer/services/ipc', () => ({
  filesIpc: { openFolder: jest.fn(), exportOrganizeReport: jest.fn() }
}));

import CompletePhase from '../src/renderer/phases/CompletePhase';

describe('CompletePhase "Analyze more files"', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockResetRun.mockClear();
  });

  test('resets the analysis run before clearing the batch', () => {
    render(<CompletePhase />);
    fireEvent.click(screen.getByText(/Analyze more files/i));

    expect(mockResetRun).toHaveBeenCalledTimes(1);
    // First, so the run's own final writes land before Redux is cleared.
    expect(mockCalls).toEqual([
      'resetRun:Analyze more files',
      'resetUi',
      'resetFilesState',
      'resetAnalysisState',
      'setPhase:discover'
    ]);
  });
});
