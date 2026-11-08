/**
 * @jest-environment jsdom
 *
 * A keyword-only chat source has no semantic score (semanticScore null,
 * keywordRelevance set). The source list and the citation preview must label
 * it as a keyword match instead of a "0%" relevance badge, and must not fall
 * back to the unbounded raw BM25 score (which rendered as e.g. "780%").
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

jest.mock('lucide-react', () => {
  const React = require('react');

  const makeIcon = (name) => {
    const Icon = (props) => React.createElement('svg', { ...props, 'data-testid': `icon-${name}` });
    Icon.displayName = name;
    return Icon;
  };

  return {
    Send: makeIcon('send'),
    RefreshCw: makeIcon('refresh-cw'),
    FileText: makeIcon('file-text'),
    AlertTriangle: makeIcon('alert-triangle'),
    RotateCcw: makeIcon('rotate-ccw'),
    ArrowUpRight: makeIcon('arrow-up-right'),
    Square: makeIcon('square'),
    Settings2: makeIcon('settings-2'),
    Image: makeIcon('image'),
    FileSpreadsheet: makeIcon('file-spreadsheet'),
    File: makeIcon('file'),
    Lightbulb: makeIcon('lightbulb'),
    Tag: makeIcon('tag'),
    Users: makeIcon('users'),
    ExternalLink: makeIcon('external-link')
  };
});

jest.mock('../../src/renderer/components/ui', () => {
  const React = require('react');

  const Button = ({ children, leftIcon, rightIcon, ...props }) => (
    <button type="button" {...props}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );

  const Textarea = (props) => <textarea {...props} />;
  const Switch = ({ checked, onChange, ...props }) => (
    <input type="checkbox" checked={checked} onChange={onChange} {...props} />
  );
  const StateMessage = ({ title, description }) => (
    <div>
      {title}
      {description}
    </div>
  );
  const Select = ({ children, ...props }) => <select {...props}>{children}</select>;
  const AlertBox = ({ children }) => <div>{children}</div>;

  return { AlertBox, Button, Textarea, Switch, StateMessage, Select };
});

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ as: Component = 'span', children, ...props }) => (
    <Component {...props}>{children}</Component>
  )
}));

jest.mock('../../src/renderer/components/search/CitationRenderer', () => ({
  __esModule: true,
  default: ({ text }) => <span>{text}</span>
}));

jest.mock('../../src/renderer/components/search/ContradictionCard', () => () => null);
jest.mock('../../src/renderer/components/search/ComparisonTable', () => () => null);
jest.mock('../../src/renderer/components/search/GapAnalysisCard', () => () => null);

import ChatPanel from '../../src/renderer/components/search/ChatPanel';
import CitationPreview from '../../src/renderer/components/search/CitationPreview';

function renderWithRedux(ui) {
  const store = configureStore({
    reducer: { system: (state = { redactPaths: false, redactPathsLoaded: true }) => state }
  });
  return render(<Provider store={store}>{ui}</Provider>);
}

function renderSources(sources) {
  return renderWithRedux(
    <ChatPanel
      messages={[
        {
          role: 'assistant',
          text: '',
          documentAnswer: [{ text: 'Total income was 84,210 [doc-1].', citations: ['doc-1'] }],
          modelAnswer: [],
          followUps: [],
          sources
        }
      ]}
      onSend={jest.fn()}
      onReset={jest.fn()}
      onOpenSource={jest.fn()}
      onUseSourcesInGraph={jest.fn()}
      isSending={false}
      statusMessage=""
      error=""
      warning=""
      useSearchContext
      onToggleSearchContext={jest.fn()}
      strictScope={false}
      onToggleStrictScope={jest.fn()}
      showGraphActions={false}
      isSearching={false}
      isLoadingStats={false}
    />
  );
}

const keywordSource = {
  id: 'doc-1',
  name: 'tax.pdf',
  score: 7.8,
  semanticScore: null,
  keywordRelevance: 1
};

describe('keyword-only source relevance badge', () => {
  test('ChatPanel source list labels a keyword-only source, with no percentage', () => {
    renderSources([keywordSource]);
    expect(screen.getByText('Keyword match')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('780%')).not.toBeInTheDocument();
  });

  test('ChatPanel source list still shows the semantic percentage', () => {
    renderSources([{ id: 'doc-1', name: 'tax.pdf', score: 1, semanticScore: 0.72 }]);
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.queryByText('Keyword match')).not.toBeInTheDocument();
  });

  test('ChatPanel shows no badge when a source has no relevance signal', () => {
    renderSources([{ id: 'doc-1', name: 'tax.pdf', score: 0.2, semanticScore: null }]);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('20%')).not.toBeInTheDocument();
    expect(screen.queryByText('Keyword match')).not.toBeInTheDocument();
  });

  test('CitationPreview labels a keyword-only source, with no percentage', () => {
    renderWithRedux(<CitationPreview source={keywordSource} onOpen={jest.fn()} />);
    expect(screen.getByText('Keyword match')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('780%')).not.toBeInTheDocument();
  });

  test('CitationPreview still shows the semantic percentage', () => {
    renderWithRedux(
      <CitationPreview source={{ name: 'tax.pdf', semanticScore: 0.72 }} onOpen={jest.fn()} />
    );
    expect(screen.getByText('72%')).toBeInTheDocument();
  });
});
