import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

import { CHAT_PERSONAS } from '../../src/shared/chatPersonas';
import ChatPanel from '../../src/renderer/components/search/ChatPanel';

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
    Users: makeIcon('users')
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

function renderWithRedux(ui, { redactPaths = false } = {}) {
  const store = configureStore({
    reducer: {
      system: (state = { redactPaths, redactPathsLoaded: true }) => state
    }
  });

  return render(<Provider store={store}>{ui}</Provider>);
}

function createBaseProps(overrides = {}) {
  return {
    messages: [],
    onSend: jest.fn(),
    onReset: jest.fn(),
    onOpenSource: jest.fn(),
    onUseSourcesInGraph: jest.fn(),
    isSending: false,
    statusMessage: '',
    error: '',
    warning: '',
    useSearchContext: true,
    onToggleSearchContext: jest.fn(),
    strictScope: false,
    onToggleStrictScope: jest.fn(),
    showGraphActions: false,
    isSearching: false,
    isLoadingStats: false,
    ...overrides
  };
}

describe('ChatPanel', () => {
  test('prefers cited document answers and strips local paths from rendered assistant text', () => {
    const sourcePath = 'C:\\Users\\alex\\Documents\\Financial\\budget-spreadsheet-2025-12-23.xlsx';

    renderWithRedux(
      <ChatPanel
        {...createBaseProps({
          messages: [
            {
              role: 'assistant',
              text: '',
              documentAnswer: [
                {
                  text: `The document is located in '${sourcePath}' and tracks the Q1 2024 budget.`,
                  citations: ['doc-1']
                }
              ],
              modelAnswer: [
                {
                  text: 'Pay attention to any specific areas where costs may exceed projections.'
                }
              ],
              followUps: ['Review expense categories'],
              sources: [
                {
                  id: 'doc-1',
                  name: 'budget-spreadsheet-2025-12-23.xlsx',
                  path: sourcePath,
                  documentType: 'Spreadsheet'
                }
              ]
            }
          ]
        })}
      />
    );

    expect(
      screen.getByText(
        "The document is located in 'budget-spreadsheet-2025-12-23.xlsx' and tracks the Q1 2024 budget."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(sourcePath)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Pay attention to any specific areas where costs may exceed projections.')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review expense categories' })).toBeInTheDocument();
  });

  test('falls back to model answers when no document answer is available', () => {
    renderWithRedux(
      <ChatPanel
        {...createBaseProps({
          messages: [
            {
              role: 'assistant',
              text: '',
              documentAnswer: [],
              modelAnswer: [{ text: 'Focus on income projections and expense categories.' }],
              followUps: [],
              sources: []
            }
          ]
        })}
      />
    );

    expect(
      screen.getByText('Focus on income projections and expense categories.')
    ).toBeInTheDocument();
  });

  test('strips unresolved [doc-N] citations from streaming text so no broken [?] renders', () => {
    // Mid-stream, `sources` isn't attached yet, so inline citations can't be
    // resolved to a number. They must be dropped rather than surface as `[?]`.
    renderWithRedux(
      <ChatPanel
        {...createBaseProps({
          isSending: true,
          messages: [
            {
              role: 'assistant',
              text: 'The document outlines a trading strategy [doc-1]. This is highly relevant [doc-2] to your query.',
              isStreaming: true
            }
          ]
        })}
      />
    );

    expect(
      screen.getByText(
        'The document outlines a trading strategy. This is highly relevant to your query.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[doc-/)).not.toBeInTheDocument();
  });

  test('keeps [doc-N] citations that resolve to a known source', () => {
    renderWithRedux(
      <ChatPanel
        {...createBaseProps({
          isSending: true,
          messages: [
            {
              role: 'assistant',
              text: 'Revenue grew last quarter [doc-1].',
              isStreaming: true,
              sources: [{ id: 'doc-1', name: 'q1.pdf' }]
            }
          ]
        })}
      />
    );

    expect(screen.getByText('Revenue grew last quarter [doc-1].')).toBeInTheDocument();
  });

  test('lists custom persona options when chatPersonaOptions is supplied', () => {
    const customOptions = [
      ...CHAT_PERSONAS,
      { id: 'custom:test-p', label: 'Test Custom', description: '', guidance: 'Be helpful.' }
    ];
    renderWithRedux(
      <ChatPanel
        {...createBaseProps({
          chatPersona: 'custom:test-p',
          onChatPersonaChange: jest.fn(),
          chatPersonaOptions: customOptions
        })}
      />
    );
    const personaSelect = screen.getByTitle('Choose chat persona');
    expect(personaSelect).toHaveValue('custom:test-p');
    expect(screen.getByRole('option', { name: 'Test Custom' })).toBeInTheDocument();
  });
});

describe('ChatPanel search-context scope line', () => {
  test('names the scope when search context is on and a search has results', () => {
    renderWithRedux(
      <ChatPanel {...createBaseProps({ useSearchContext: true, searchContextCount: 14 })} />
    );

    expect(screen.getByTestId('chat-search-context-scope')).toHaveTextContent(
      'Answering from your last search: 14 files'
    );
  });

  test('says there is nothing to scope to when search context is on without results', () => {
    renderWithRedux(
      <ChatPanel {...createBaseProps({ useSearchContext: true, searchContextCount: 0 })} />
    );

    expect(screen.getByTestId('chat-search-context-scope')).toHaveTextContent(
      'run a search to answer from its results'
    );
  });

  test('shows nothing when search context is off', () => {
    renderWithRedux(
      <ChatPanel {...createBaseProps({ useSearchContext: false, searchContextCount: 14 })} />
    );

    expect(screen.queryByTestId('chat-search-context-scope')).toBeNull();
  });
});
