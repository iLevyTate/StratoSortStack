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

// A tester could not tell what "Embed: Local" on every Discover card meant. The
// card now says how search can find the file, in plain words; the
// hover title keeps the full setting name.
describe('AnalysisResultsList search label', () => {
  const readyState = () => ({
    label: 'Ready',
    icon: null,
    color: 'text-green-500',
    spinning: false
  });
  const renderFile = (extra) =>
    render(
      <AnalysisResultsList
        results={[
          {
            path: '/docs/gsc-export.xlsx',
            name: 'gsc-export.xlsx',
            analysis: { category: 'SEO', suggestedName: 'gsc', confidence: 0.6, keywords: [] },
            ...extra
          }
        ]}
        onFileAction={jest.fn()}
        getFileStateDisplay={readyState}
        fileStates={{}}
      />
    );

  test('a file stored for search by meaning says so, not "Embed: Local"', () => {
    renderFile({});
    expect(screen.getByText('Search by meaning')).toBeInTheDocument();
    expect(screen.queryByText('Embed: Local')).not.toBeInTheDocument();
    expect(screen.getByText('Search by meaning')).toHaveAttribute(
      'title',
      'Embedding policy: Embed locally'
    );
  });

  // Skip and web-only only leave out the local vectors: keyword search still
  // finds the file, so neither may claim it is out of search.
  test.each(['skip', 'web_only'])('a %s file reads "Keyword search only"', (embeddingPolicy) => {
    renderFile({ embeddingPolicy });
    expect(screen.getByText('Keyword search only')).toBeInTheDocument();
    expect(screen.queryByText('Not in search')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Embed:/)).not.toBeInTheDocument();
  });
});
