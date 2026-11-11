/**
 * @jest-environment jsdom
 *
 * The timeline list is measured with a ResizeObserver on a container that only
 * exists while there are rows. The observer has to follow that container: the
 * tab mounts before its first page has loaded, and a refresh empties the list
 * before refilling it.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-window', () => ({
  List: ({ rowCount, style }) => (
    <div data-testid="timeline-list" data-row-count={rowCount} data-height={style?.height} />
  )
}));

jest.mock('../../../../src/renderer/components/ui', () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>
}));

import TimelineTabContent from '../../../../src/renderer/components/search/TimelineTabContent';

const ITEMS = [
  {
    id: 'a',
    fileName: 'report.pdf',
    filePath: 'C:\\docs\\report.pdf',
    effectiveDate: '2026-03-04',
    dateSource: 'content'
  },
  {
    id: 'b',
    fileName: 'notes.txt',
    filePath: 'C:\\docs\\notes.txt',
    effectiveDate: '2026-02-11',
    dateSource: 'content'
  }
];

/** @type {Array<{ callback: Function, observe: jest.Mock, disconnect: jest.Mock }>} */
let observers;

function baseProps(overrides = {}) {
  return {
    items: [],
    total: 0,
    hasMore: false,
    isLoading: false,
    error: '',
    loadMore: jest.fn(),
    onOpenFile: jest.fn(),
    ...overrides
  };
}

function reportHeight(observer, height) {
  act(() => {
    observer.callback([{ contentRect: { height } }]);
  });
}

describe('TimelineTabContent list height', () => {
  beforeEach(() => {
    observers = [];
    window.ResizeObserver = jest.fn().mockImplementation((callback) => {
      const observer = { callback, observe: jest.fn(), disconnect: jest.fn() };
      observers.push(observer);
      return observer;
    });
  });

  afterEach(() => {
    delete window.ResizeObserver;
  });

  test('measures the list when the first page arrives after the tab mounted empty', () => {
    const { rerender } = render(<TimelineTabContent {...baseProps({ isLoading: true })} />);
    expect(screen.queryByTestId('timeline-list')).not.toBeInTheDocument();

    rerender(<TimelineTabContent {...baseProps({ items: ITEMS, total: ITEMS.length })} />);

    const list = screen.getByTestId('timeline-list');
    const active = observers.filter((o) => o.disconnect.mock.calls.length === 0);
    expect(active).toHaveLength(1);
    expect(active[0].observe).toHaveBeenCalledWith(list.parentElement);

    reportHeight(active[0], 800);
    expect(screen.getByTestId('timeline-list')).toHaveAttribute('data-height', '800');
  });

  test('measures the new list after a refresh emptied and refilled it', () => {
    const { rerender } = render(
      <TimelineTabContent {...baseProps({ items: ITEMS, total: ITEMS.length })} />
    );
    const first = observers[observers.length - 1];
    expect(first.observe).toHaveBeenCalledWith(screen.getByTestId('timeline-list').parentElement);

    rerender(<TimelineTabContent {...baseProps({ isLoading: true })} />);
    expect(first.disconnect).toHaveBeenCalled();

    rerender(<TimelineTabContent {...baseProps({ items: ITEMS, total: ITEMS.length })} />);

    const list = screen.getByTestId('timeline-list');
    const active = observers.filter((o) => o.disconnect.mock.calls.length === 0);
    expect(active).toHaveLength(1);
    expect(active[0]).not.toBe(first);
    expect(active[0].observe).toHaveBeenCalledWith(list.parentElement);

    reportHeight(active[0], 640);
    expect(screen.getByTestId('timeline-list')).toHaveAttribute('data-height', '640');
  });
});
