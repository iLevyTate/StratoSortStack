/**
 * @jest-environment jsdom
 *
 * The Complete screen accounts for every file of the session: no "+N more",
 * each file's full location, the folders files went to, and a CSV export.
 */
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockState = { organizedFiles: [] };
jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => jest.fn()),
  useAppSelector: jest.fn((selector) =>
    selector({
      files: { organizedFiles: mockState.organizedFiles, organizedPathIndex: [] },
      analysis: { results: [] }
    })
  )
}));

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
jest.mock('../../src/renderer/store/slices/filesSlice', () => ({ resetFilesState: jest.fn() }));
jest.mock('../../src/renderer/store/slices/analysisSlice', () => ({
  resetAnalysisState: jest.fn()
}));
jest.mock('../../src/renderer/store/middleware/persistenceMiddleware', () => ({
  cancelPendingPersistence: jest.fn()
}));
jest.mock('../../src/renderer/components/UndoRedoSystem', () => ({
  UndoRedoToolbar: () => <div>UNDO_REDO</div>
}));
jest.mock('framer-motion', () => ({
  motion: { div: ({ children, className }) => <div className={className}>{children}</div> },
  useReducedMotion: jest.fn(() => true)
}));

const mockRevealFile = jest.fn();
jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({ revealFile: mockRevealFile })
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({
    showError: mockShowError,
    showInfo: jest.fn(),
    showSuccess: mockShowSuccess,
    showWarning: jest.fn()
  })
}));

const mockOpenFolder = jest.fn().mockResolvedValue({ success: true });
const mockExport = jest.fn();
jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: {
    openFolder: (...args) => mockOpenFolder(...args),
    exportOrganizeReport: (...args) => mockExport(...args)
  }
}));

import CompletePhase from '../../src/renderer/phases/CompletePhase';

const organized = (i, folder) => ({
  originalPath: `C:\\Users\\Alex\\Downloads\\export-${i}.xlsx`,
  originalName: `export-${i}.xlsx`,
  path: `C:\\Users\\Alex\\SEO\\${folder}\\export-${i}.xlsx`,
  smartFolder: folder
});

describe('Complete screen: every file of the session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.organizedFiles = Array.from({ length: 20 }, (_, i) =>
      organized(i, i < 15 ? 'Search Console' : 'Bing')
    );
  });

  test('lists all 20 files with their full location, and no "+N more"', () => {
    render(<CompletePhase />);

    for (let i = 0; i < 20; i += 1) {
      expect(screen.getByText(`export-${i}.xlsx`)).toBeInTheDocument();
    }
    expect(screen.queryByText(/^\+\d+ more files?$/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Now at C:\\Users\\Alex\\SEO\\Bing\\export-19.xlsx')
    ).toBeInTheDocument();
    expect(screen.getAllByText('From C:\\Users\\Alex\\Downloads')).toHaveLength(20);
  });

  test('says how many files went to each folder, and opens one', async () => {
    render(<CompletePhase />);

    const where = screen.getByRole('region', { name: 'Where files went' });
    expect(within(where).getByText('C:\\Users\\Alex\\SEO\\Search Console')).toBeInTheDocument();
    expect(within(where).getByText('15 files')).toBeInTheDocument();
    expect(within(where).getByText('5 files')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(where).getByRole('button', { name: 'Open Bing' }));
    });
    expect(mockOpenFolder).toHaveBeenCalledWith('C:\\Users\\Alex\\SEO\\Bing');
  });

  test('every row can be shown in its folder', () => {
    render(<CompletePhase />);

    const reveal = screen.getAllByRole('button', { name: /^Show export-\d+\.xlsx in its folder$/ });
    expect(reveal).toHaveLength(20);
    fireEvent.click(reveal[19]);
    expect(mockRevealFile).toHaveBeenCalledWith('C:\\Users\\Alex\\SEO\\Bing\\export-19.xlsx');
  });

  test('Save list as CSV sends every file and says where the list went', async () => {
    mockExport.mockResolvedValue({
      success: true,
      filePath: 'C:\\Users\\Alex\\Documents\\organize.csv',
      rowCount: 20
    });
    render(<CompletePhase />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save list as CSV' }));
    });
    const sent = mockExport.mock.calls[0][0];
    expect(sent).toHaveLength(20);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        name: 'export-0.xlsx',
        originalPath: 'C:\\Users\\Alex\\Downloads\\export-0.xlsx',
        finalPath: 'C:\\Users\\Alex\\SEO\\Search Console\\export-0.xlsx',
        outcome: 'moved'
      })
    );
    expect(mockShowSuccess).toHaveBeenCalledWith('Saved the list of 20 files to organize.csv.');
  });
});
