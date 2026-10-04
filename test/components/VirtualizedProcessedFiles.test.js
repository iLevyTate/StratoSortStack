/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { selectRedactPaths } from '../../src/renderer/store/selectors';

jest.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: RowComponent, rowProps, style }) => (
    <div style={style}>
      {Array.from({ length: rowCount }).map((_, index) => (
        <RowComponent key={index} index={index} style={{}} {...rowProps} />
      ))}
    </div>
  )
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: jest.fn(() => false)
}));

jest.mock('react-redux', () => ({
  useSelector: jest.fn((selector) => selector({}))
}));

jest.mock('../../src/renderer/components/ui', () => ({
  StatusBadge: ({ children }) => <div>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children, className }) => <span className={className}>{children}</span>
}));

jest.mock('../../src/renderer/utils/pathDisplay', () => ({
  formatDisplayFileName: jest.fn((value, options = {}) =>
    options.redact
      ? `Hidden file${value?.includes('.') ? value.slice(value.lastIndexOf('.')) : ''}`
      : value
  )
}));

import VirtualizedProcessedFiles from '../../src/renderer/components/organize/VirtualizedProcessedFiles';

describe('VirtualizedProcessedFiles', () => {
  test('redacts organized history labels when privacy redaction is enabled', () => {
    selectRedactPaths.mockReturnValue(true);

    render(
      <VirtualizedProcessedFiles
        files={[
          {
            originalPath: '/docs/Final_Advisor_Agreement_Duncan_Sopko-signed.pdf',
            originalName: 'Final_Advisor_Agreement_Duncan_Sopko-signed.pdf',
            newName: 'advisor-agreement-2026-03-24.pdf',
            smartFolder: 'Financial',
            organizedAt: '2026-03-24T00:00:00.000Z'
          }
        ]}
      />
    );

    expect(
      screen.queryByText(/Final_Advisor_Agreement_Duncan_Sopko-signed\.pdf/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/advisor-agreement-2026-03-24\.pdf/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Moved to Financial/i)).not.toBeInTheDocument();
    expect(screen.getByText('Hidden file.pdf -> Hidden file.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Moved successfully/i)).toBeInTheDocument();
  });

  test('keeps long row content constrained within the card layout', () => {
    selectRedactPaths.mockReturnValue(false);

    const { container } = render(
      <VirtualizedProcessedFiles
        files={[
          {
            originalPath:
              '/docs/really-long-original-filename-that-should-not-push-the-row-outside-the-card.zip',
            originalName:
              'really-long-original-filename-that-should-not-push-the-row-outside-the-card.zip',
            newName:
              'another-extremely-long-generated-name-that-needs-truncation-in-the-ui-2026-03-24.zip',
            smartFolder: 'Archives',
            organizedAt: '2026-03-24T00:00:00.000Z'
          }
        ]}
      />
    );

    expect(container.querySelector('.min-w-0')).toBeInTheDocument();
    expect(container.querySelector('.truncate')).toBeInTheDocument();
    expect(container.querySelector('.overflow-hidden')).toBeInTheDocument();
  });
});
