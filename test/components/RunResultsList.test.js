/**
 * @jest-environment jsdom
 *
 * RunResultsList accounts for every file of a run: where each one is now,
 * per-folder totals, why a file did not move, and a way to show each file in
 * its folder.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: RowComponent, rowProps, style }) => (
    <div style={style} data-testid="virtual-list">
      {Array.from({ length: rowCount }).map((_, index) => (
        <RowComponent key={index} index={index} style={{}} {...rowProps} />
      ))}
    </div>
  )
}));

import RunResultsList from '../../src/renderer/components/organize/RunResultsList';

const moved = (i, folder = 'C:\\D\\GSC') => ({
  name: `report-${i}.xlsx`,
  originalPath: `C:\\In\\report-${i}.xlsx`,
  finalPath: `${folder}\\report-${i}.xlsx`,
  outcome: 'moved',
  reason: ''
});

describe('RunResultsList', () => {
  test('every row has its full location and a Show-in-folder button', () => {
    const onReveal = jest.fn();
    const rows = Array.from({ length: 25 }, (_, i) => moved(i));
    render(<RunResultsList rows={rows} onReveal={onReveal} onOpenFolder={jest.fn()} />);

    const buttons = screen.getAllByRole('button', {
      name: /^Show report-\d+\.xlsx in its folder$/
    });
    expect(buttons).toHaveLength(25);
    expect(screen.getByText('Now at C:\\D\\GSC\\report-24.xlsx')).toBeInTheDocument();
    fireEvent.click(buttons[3]);
    expect(onReveal).toHaveBeenCalledWith('C:\\D\\GSC\\report-3.xlsx');
  });

  test('a long list is virtualized and still has a row per file', () => {
    const rows = Array.from({ length: 40 }, (_, i) => moved(i));
    render(<RunResultsList rows={rows} onReveal={jest.fn()} onOpenFolder={jest.fn()} />);

    expect(screen.getByTestId('virtual-list')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /in its folder$/ })).toHaveLength(40);
  });

  test('"Where files went" lists each folder with its count and opens it', () => {
    const onOpenFolder = jest.fn();
    const rows = [
      moved(1),
      moved(2),
      moved(3, 'C:\\D\\Bing'),
      {
        name: 'report-3 (1).xlsx',
        originalPath: 'C:\\In\\report-3 (1).xlsx',
        finalPath: 'C:\\D\\Bing\\report-3.xlsx',
        outcome: 'duplicate',
        reason: 'This copy is in the system Trash.'
      }
    ];
    render(<RunResultsList rows={rows} onReveal={jest.fn()} onOpenFolder={onOpenFolder} />);

    const where = screen.getByRole('region', { name: 'Where files went' });
    expect(within(where).getByText('C:\\D\\GSC')).toBeInTheDocument();
    expect(within(where).getByText('2 files')).toBeInTheDocument();
    expect(within(where).getByText('1 file, 1 duplicate removed')).toBeInTheDocument();
    fireEvent.click(within(where).getByRole('button', { name: 'Open Bing' }));
    expect(onOpenFolder).toHaveBeenCalledWith('C:\\D\\Bing');
  });

  test('the header adds up, and Not moved shows only the files that stayed', () => {
    const rows = [
      moved(1),
      moved(2),
      {
        name: 'blocked.csv',
        originalPath: '/in/blocked.csv',
        finalPath: null,
        outcome: 'failed',
        reason: 'Access denied.'
      },
      {
        name: 'late.csv',
        originalPath: '/in/late.csv',
        finalPath: null,
        outcome: 'notMoved',
        reason: 'The run stopped before this file.'
      }
    ];
    const onReveal = jest.fn();
    render(<RunResultsList rows={rows} onReveal={onReveal} onOpenFolder={jest.fn()} />);

    expect(screen.getByText('2 moved · 2 not moved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not moved (2)' }));
    expect(screen.getByRole('button', { name: 'Not moved (2)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByText('report-1.xlsx')).not.toBeInTheDocument();
    expect(screen.getByText('Not moved: Access denied.')).toBeInTheDocument();
    expect(screen.getByText('Still at /in/blocked.csv')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show blocked.csv in its folder' }));
    expect(onReveal).toHaveBeenCalledWith('/in/blocked.csv');

    fireEvent.click(screen.getByRole('button', { name: 'All (4)' }));
    expect(screen.getByText('report-1.xlsx')).toBeInTheDocument();
  });

  test('no Not moved filter when everything moved', () => {
    render(<RunResultsList rows={[moved(1)]} onReveal={jest.fn()} onOpenFolder={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /^Not moved/ })).not.toBeInTheDocument();
  });

  test('a file renamed because the name was taken says so', () => {
    render(
      <RunResultsList
        rows={[
          { ...moved(1), finalPath: 'C:\\D\\GSC\\report-1 (1).xlsx', renamedOnCollision: true }
        ]}
        onReveal={jest.fn()}
        onOpenFolder={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        'Now at C:\\D\\GSC\\report-1 (1).xlsx (renamed: a file with this name was already there)'
      )
    ).toBeInTheDocument();
  });

  test('a removed duplicate points at the kept copy', () => {
    const onReveal = jest.fn();
    render(
      <RunResultsList
        rows={[
          {
            name: 'a (1).csv',
            originalPath: '/in/a (1).csv',
            finalPath: '/D/Bing/a.csv',
            outcome: 'duplicate',
            reason: 'This copy is in the system Trash.'
          }
        ]}
        onReveal={onReveal}
        onOpenFolder={jest.fn()}
      />
    );
    expect(
      screen.getByText(
        'Not moved: an identical copy is already at /D/Bing/a.csv. This copy is in the system Trash.'
      )
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show the kept copy of a (1).csv in its folder' })
    );
    expect(onReveal).toHaveBeenCalledWith('/D/Bing/a.csv');
  });

  test('privacy redaction hides every path', () => {
    const { container } = render(
      <RunResultsList
        rows={[
          moved(1),
          {
            name: 'x.csv',
            originalPath: '/in/x.csv',
            finalPath: null,
            outcome: 'failed',
            reason: 'No.'
          }
        ]}
        onReveal={jest.fn()}
        onOpenFolder={jest.fn()}
        redactPaths
      />
    );
    expect(container.textContent).not.toMatch(/C:\\D|\/in\//);
    expect(screen.getAllByText(/Destination hidden/).length).toBeGreaterThan(0);
  });

  test('Save list as CSV calls onExport, and is absent without it', () => {
    const onExport = jest.fn();
    const { rerender } = render(
      <RunResultsList
        rows={[moved(1)]}
        onReveal={jest.fn()}
        onOpenFolder={jest.fn()}
        onExport={onExport}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save list as CSV' }));
    expect(onExport).toHaveBeenCalled();

    rerender(<RunResultsList rows={[moved(1)]} onReveal={jest.fn()} onOpenFolder={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save list as CSV' })).not.toBeInTheDocument();
  });
});
