/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-redux', () => ({
  useDispatch: () => jest.fn(),
  useSelector: (selector) => selector({})
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: () => false,
  selectDefaultEmbeddingPolicy: () => 'embed'
}));

jest.mock('../../src/renderer/store/thunks/fileThunks', () => ({
  setEmbeddingPolicyForFile: jest.fn()
}));

jest.mock('../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayPath: (value) => value
}));

jest.mock('../../src/shared/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

jest.mock('../../src/renderer/components/common/AIProviderIcon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../src/renderer/components/ui', () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
  StatusBadge: ({ children, title }) => <span title={title}>{children}</span>,
  Card: ({ children, ...props }) => <div {...props}>{children}</div>,
  IconButton: ({ title, onClick, onKeyDown, icon }) => (
    <button type="button" title={title} onClick={onClick} onKeyDown={onKeyDown}>
      {icon}
    </button>
  ),
  StateMessage: ({ title }) => <div>{title}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children, ...props }) => <span {...props}>{children}</span>
}));

jest.mock('lucide-react', () => ({
  FileText: () => <span />,
  Compass: () => <span />,
  AlertTriangle: () => <span />,
  Eye: () => <span />,
  FolderOpen: () => <span />,
  Trash2: () => <span />,
  Database: () => <span />,
  Globe: () => <span />,
  Ban: () => <span />,
  RefreshCw: () => <span />,
  MoreVertical: () => <span />
}));

import AnalysisResultsList from '../../src/renderer/components/discover/AnalysisResultsList';

describe('AnalysisResultsList fileStates + menu keys', () => {
  const file = {
    path: '/docs/report.pdf',
    name: 'report.pdf',
    analysis: { category: 'Docs', suggestedName: 'report', confidence: 0.9, keywords: [] }
  };

  test('re-renders a row when fileStates changes without a new results array (SW-35)', () => {
    let states = { '/docs/report.pdf': { state: 'error' } };
    const getFileStateDisplay = (path) => ({
      label: states[path]?.state === 'analyzing' ? 'Analyzing...' : 'Failed',
      icon: null,
      color:
        states[path]?.state === 'analyzing' ? 'text-stratosort-blue' : 'text-stratosort-danger',
      spinning: states[path]?.state === 'analyzing'
    });

    const { rerender } = render(
      <AnalysisResultsList
        results={[file]}
        onFileAction={jest.fn()}
        getFileStateDisplay={getFileStateDisplay}
        fileStates={states}
      />
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();

    states = { '/docs/report.pdf': { state: 'analyzing' } };
    rerender(
      <AnalysisResultsList
        results={[file]}
        onFileAction={jest.fn()}
        getFileStateDisplay={getFileStateDisplay}
        fileStates={states}
      />
    );

    expect(screen.getByText('Analyzing...')).toBeInTheDocument();
  });

  test('keeps row DOM identity when an earlier file is removed (M7)', () => {
    const readyState = () => ({ label: 'Ready', icon: null, color: '', spinning: false });
    const other = {
      path: '/docs/other.pdf',
      name: 'other.pdf',
      analysis: { category: 'Docs', suggestedName: 'other', confidence: 0.8, keywords: [] }
    };
    const renderList = (results) => (
      <AnalysisResultsList
        results={results}
        onFileAction={jest.fn()}
        getFileStateDisplay={readyState}
        fileStates={{}}
      />
    );

    const { rerender } = render(renderList([other, file]));
    const rowBefore = screen.getByText('report.pdf').closest('[data-testid="file-item"]');

    rerender(renderList([file]));
    const rowAfter = screen.getByText('report.pdf').closest('[data-testid="file-item"]');

    expect(rowAfter).toBe(rowBefore);
  });

  test('arrow keys move focus between menu items (SW-83)', () => {
    render(
      <AnalysisResultsList
        results={[file]}
        onFileAction={jest.fn()}
        getFileStateDisplay={() => ({
          label: 'Ready',
          icon: null,
          color: 'text-green-500',
          spinning: false
        })}
        fileStates={{ '/docs/report.pdf': { state: 'ready' } }}
      />
    );

    fireEvent.click(screen.getByTitle('Actions'));
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(1);

    items[0].focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });
});
