/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/organize/ReadyFileItem', () => ({
  __esModule: true,
  default: ({ file }) => <div>{file.name}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));

jest.mock('../../src/renderer/components/ErrorBoundary', () => ({
  ErrorBoundaryCore: ({ children }) => <>{children}</>
}));

import VirtualizedFileGrid from '../../src/renderer/components/organize/VirtualizedFileGrid';

describe('VirtualizedFileGrid row keys (M7)', () => {
  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterAll(() => {
    delete global.ResizeObserver;
  });

  const makeFile = (name) => ({
    path: `C:\\Inbox\\${name}`,
    name,
    analysis: { category: 'Docs' }
  });

  const renderGrid = (files) => (
    <VirtualizedFileGrid
      files={files}
      selectedFiles={new Set()}
      toggleFileSelection={jest.fn()}
      getFileWithEdits={(file) => file}
      editingFiles={{}}
      findSmartFolderForCategory={() => null}
      getFileStateDisplay={() => ({ label: 'Ready', icon: null, color: '', spinning: false })}
      handleEditFile={jest.fn()}
      smartFolders={[]}
      defaultLocation=""
      onViewDetails={jest.fn()}
    />
  );

  test('keeps the surviving row mounted when an earlier file is removed', () => {
    const { rerender } = render(renderGrid([makeFile('a.pdf'), makeFile('b.pdf')]));
    const rowBefore = screen.getByText('b.pdf').closest('[data-organize-file-index]');
    expect(rowBefore).toHaveAttribute('data-organize-file-index', '1');

    rerender(renderGrid([makeFile('b.pdf')]));
    const rowAfter = screen.getByText('b.pdf').closest('[data-organize-file-index]');

    expect(rowAfter).toBe(rowBefore);
    expect(rowAfter).toHaveAttribute('data-organize-file-index', '0');
  });

  test('renders files without a path using a positional fallback key', () => {
    render(
      renderGrid([
        { name: 'ghost.pdf', analysis: {} },
        { name: 'phantom.pdf', analysis: {} }
      ])
    );

    expect(screen.getByText('ghost.pdf')).toBeInTheDocument();
    expect(screen.getByText('phantom.pdf')).toBeInTheDocument();
  });
});
