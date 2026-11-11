/**
 * DocumentScopePanel — dropping files or folders onto the scope panel.
 *
 * On Electron 32+ a dropped File has no `.path`; the absolute path comes from
 * the preload's webUtils bridge (electronAPI.files.getPathForDroppedFile).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import DocumentScopePanel from '../../src/renderer/components/search/DocumentScopePanel';

jest.mock('lucide-react', () => {
  const React = require('react');
  const makeIcon = (name) => {
    const Icon = (props) => React.createElement('svg', { ...props, 'data-testid': `icon-${name}` });
    Icon.displayName = name;
    return Icon;
  };
  return {
    X: makeIcon('x'),
    FileText: makeIcon('file-text'),
    Folder: makeIcon('folder'),
    Plus: makeIcon('plus'),
    FolderInput: makeIcon('folder-input'),
    ChevronRight: makeIcon('chevron-right')
  };
});

jest.mock('../../src/renderer/components/ui', () => {
  const React = require('react');
  const Button = ({ children, variant: _variant, size: _size, ...props }) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const IconButton = ({ icon, variant: _variant, size: _size, ...props }) => (
    <button type="button" {...props}>
      {icon}
    </button>
  );
  return { Button, IconButton };
});

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ as: Component = 'span', children, variant: _variant, ...props }) => (
    <Component {...props}>{children}</Component>
  )
}));

function renderPanel(onAddToScope) {
  render(
    <DocumentScopePanel
      scope={[]}
      onAddToScope={onAddToScope}
      onRemoveFromScope={jest.fn()}
      onClearScope={jest.fn()}
    />
  );
  // The drop surface is the scrollable area that holds the empty-state hint.
  return screen.getByText(/Drag files or folders here/i).parentElement.parentElement;
}

describe('DocumentScopePanel drop', () => {
  const originalApi = window.electronAPI;
  /** Synthetic absolute paths keyed by dropped File, as webUtils.getPathForFile would give. */
  let droppedPaths;

  beforeEach(() => {
    droppedPaths = new WeakMap();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        files: {
          getPathForDroppedFile: jest.fn((file) => droppedPaths.get(file) || '')
        }
      }
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  });

  test('a dropped file is added with the path from the preload bridge, not File.path', () => {
    const onAddToScope = jest.fn();
    const dropZone = renderPanel(onAddToScope);

    // A real File: like Electron 45, it has a name but no `.path`.
    const file = new File(['synthetic'], 'report.pdf', { type: 'application/pdf' });
    droppedPaths.set(file, '/synthetic/docs/report.pdf');

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [file],
        items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }]
      }
    });

    expect(onAddToScope).toHaveBeenCalledTimes(1);
    expect(onAddToScope).toHaveBeenCalledWith([
      { path: '/synthetic/docs/report.pdf', name: 'report.pdf', type: 'file' }
    ]);
  });

  test('a dropped folder is passed on as a folder so its files are added', () => {
    const onAddToScope = jest.fn();
    const dropZone = renderPanel(onAddToScope);

    const folder = new File([], 'Invoices');
    const file = new File(['synthetic'], 'notes.txt', { type: 'text/plain' });
    droppedPaths.set(folder, '/synthetic/docs/Invoices');
    droppedPaths.set(file, '/synthetic/docs/notes.txt');

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [folder, file],
        items: [
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }
        ]
      }
    });

    expect(onAddToScope).toHaveBeenCalledWith([
      { path: '/synthetic/docs/Invoices', name: 'Invoices', type: 'folder' },
      { path: '/synthetic/docs/notes.txt', name: 'notes.txt', type: 'file' }
    ]);
  });
});
