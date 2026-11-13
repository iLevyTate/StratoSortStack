/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));

jest.mock('lucide-react', () => ({
  FolderOpen: () => <span />
}));

import AnalysisProgress from '../../src/renderer/components/discover/AnalysisProgress';

describe('AnalysisProgress live region (SW-79)', () => {
  test('surface="none" still exposes a status live region', () => {
    render(
      <AnalysisProgress
        surface="none"
        progress={{ current: 1, total: 4 }}
        currentFile="/tmp/a.pdf"
      />
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('AnalysisProgress wording', () => {
  test('the percentage is labeled as progress and shown once', () => {
    render(<AnalysisProgress progress={{ current: 26, total: 39 }} />);

    expect(screen.getByText('Analyzing 26 of 39 files')).toBeInTheDocument();
    expect(screen.getByText('67% complete')).toBeInTheDocument();
    expect(screen.queryByText('67%')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '67 percent complete'
    );
  });

  test('one file is not "files"', () => {
    render(<AnalysisProgress progress={{ current: 0, total: 1 }} />);

    expect(screen.getByText('Analyzing 0 of 1 file')).toBeInTheDocument();
  });
});

describe('AnalysisProgress says why the run is running', () => {
  test.each([
    ['added', 'Files you added'],
    ['queued', 'Files you added while the last run was going'],
    ['resume', 'Continuing a run that was interrupted'],
    ['retry', 'Trying again the files that failed'],
    ['reanalyze', 'Analyzing again because you chose Reanalyze']
  ])('origin %s shows "%s"', (origin, text) => {
    render(<AnalysisProgress progress={{ current: 26, total: 39 }} origin={origin} />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Analyzing 26 of 39 files')).toBeInTheDocument();
  });

  test('no origin, or an unknown one, shows no reason line', () => {
    const { container, rerender } = render(
      <AnalysisProgress progress={{ current: 1, total: 4 }} />
    );
    const withoutOrigin = container.textContent;
    rerender(<AnalysisProgress progress={{ current: 1, total: 4 }} origin="bogus" />);

    expect(container.textContent).toBe(withoutOrigin);
    expect(screen.queryByText('Files you added')).not.toBeInTheDocument();
  });

  test('once the run is done the reason line goes away', () => {
    render(<AnalysisProgress progress={{ current: 39, total: 39 }} origin="resume" />);

    expect(screen.getByText('Analysis complete')).toBeInTheDocument();
    expect(screen.queryByText('Continuing a run that was interrupted')).not.toBeInTheDocument();
  });
});
