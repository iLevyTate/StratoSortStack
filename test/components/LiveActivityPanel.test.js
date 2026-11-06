/**
 * @jest-environment jsdom
 *
 * The floating Live Activity panel: tabs, filters, controls, redaction,
 * minimize/close, keyboard/focus behavior, and layout persistence
 * (including when storage throws).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const mockDispatch = jest.fn();
const mockPause = jest.fn();
const mockResume = jest.fn();
const mockClear = jest.fn();
const mockScrollToRow = jest.fn();
let mockState;
let mockFeed;

jest.mock('react-window', () => {
  const ReactActual = jest.requireActual('react');
  return {
    List: function MockList({
      rowCount,
      rowComponent: RowComponent,
      rowProps,
      style,
      listRef,
      rowHeight: _rowHeight,
      overscanCount: _overscanCount,
      defaultHeight: _defaultHeight,
      ...rest
    }) {
      ReactActual.useImperativeHandle(listRef, () => ({
        element: null,
        scrollToRow: mockScrollToRow
      }));
      return (
        <div role="list" data-testid="virtual-list" style={style} {...rest}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <RowComponent
              key={index}
              index={index}
              style={{}}
              ariaAttributes={{
                role: 'listitem',
                'aria-posinset': index + 1,
                'aria-setsize': rowCount
              }}
              {...rowProps}
            />
          ))}
        </div>
      );
    }
  };
});

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector(mockState)
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: (state) => state.redactPaths
}));

jest.mock('../../src/renderer/store/thunks/liveActivityThunks', () => ({
  setShowLiveActivity: jest.fn((enabled) => ({
    type: 'test/setShowLiveActivity',
    payload: enabled
  }))
}));

jest.mock('../../src/renderer/hooks/useLiveLogFeed', () => ({
  useLiveLogFeed: () => mockFeed
}));

import LiveActivityPanel from '../../src/renderer/components/diagnostics/LiveActivityPanel';

const STORAGE_KEY = 'stratosort_live_activity_panel';

function entry(id, overrides = {}) {
  return {
    id,
    time: new Date(2026, 10, 5, 9, 0, id).toISOString(),
    level: 'info',
    context: 'SmartFolderWatcher',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

const ENTRIES = [
  entry(1, {
    msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt-0412.jpg',
    activity: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  }),
  entry(2, {
    level: 'debug',
    context: 'OramaVectorService',
    msg: '[OramaVectorService] Persisted databases',
    dataText: '{"collections":["files"]}',
    activity: {
      kind: 'index-saved',
      icon: 'save',
      tone: 'success',
      text: 'Saved search index (files)'
    }
  }),
  entry(3, {
    level: 'warn',
    context: 'DownloadWatcher',
    msg: '[DOWNLOAD-WATCHER] Cannot access file:',
    dataText: '{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}',
    activity: {
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: 'Problem: Cannot access file:'
    }
  }),
  entry(4, { context: 'LlamaService', msg: '[LlamaService] Model configuration updated' })
];

function makeFeed(overrides = {}) {
  return {
    entries: ENTRIES,
    status: 'live',
    paused: false,
    pausedCount: 0,
    dropped: 0,
    recentlyActive: false,
    pause: mockPause,
    resume: mockResume,
    clear: mockClear,
    ...overrides
  };
}

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height
  });
}

function seedState(state = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      minimized: false,
      tab: 'activity',
      ...state
    })
  );
}

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY));
}

function region() {
  return screen.queryByRole('region', { name: 'Live activity' });
}

function dragHandle() {
  return screen.getByRole('group', { name: /Move live activity panel/ });
}

describe('LiveActivityPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    setViewport(1200, 900);
    mockState = { redactPaths: false };
    mockFeed = makeFeed();
  });

  describe('Activity tab', () => {
    test('is the default and shows recognized events in plain words', () => {
      render(<LiveActivityPanel />);

      expect(region()).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.getByText('Analyzing receipt-0412.jpg')).toBeInTheDocument();
      expect(screen.getByText('Saved search index (files)')).toBeInTheDocument();
      expect(
        screen.queryByText('[LlamaService] Model configuration updated')
      ).not.toBeInTheDocument();
    });

    test('problems show the context they came from', () => {
      render(<LiveActivityPanel />);
      expect(screen.getByText('Problem: Cannot access file:')).toBeInTheDocument();
      expect(screen.getByText('DownloadWatcher')).toBeInTheDocument();
      // Only problem rows carry a context tag.
      expect(screen.queryByText('SmartFolderWatcher')).not.toBeInTheDocument();
    });

    test('an empty or unknown icon name falls back to the generic activity icon', () => {
      mockFeed = makeFeed({
        entries: [
          entry(10, {
            activity: { kind: 'x', icon: '', tone: 'info', text: 'Empty icon' }
          }),
          entry(11, {
            activity: { kind: 'x', icon: 'constructor', tone: 'bogus', text: 'Odd icon' }
          })
        ]
      });
      const { container } = render(<LiveActivityPanel />);
      expect(screen.getByText('Empty icon')).toBeInTheDocument();
      expect(screen.getByText('Odd icon')).toBeInTheDocument();
      expect(container.querySelectorAll('svg.lucide-activity')).toHaveLength(2);
    });

    test('says it is waiting when nothing has happened yet', () => {
      mockFeed = makeFeed({ entries: [] });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Waiting for activity…')).toBeInTheDocument();
    });

    test('says when it is still connecting', () => {
      mockFeed = makeFeed({ entries: [], status: 'connecting' });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });
  });

  describe('Raw tab', () => {
    test('lists every record and filters by minimum level and context', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));

      expect(screen.getByText('[LlamaService] Model configuration updated')).toBeInTheDocument();
      expect(screen.getByText('[OramaVectorService] Persisted databases')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'warn' } });
      expect(
        screen.queryByText('[LlamaService] Model configuration updated')
      ).not.toBeInTheDocument();
      expect(screen.getByText('[DOWNLOAD-WATCHER] Cannot access file:')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'debug' } });
      fireEvent.change(screen.getByLabelText('Context'), {
        target: { value: 'OramaVectorService' }
      });
      expect(screen.getByText('[OramaVectorService] Persisted databases')).toBeInTheDocument();
      expect(screen.queryByText('[DOWNLOAD-WATCHER] Cannot access file:')).not.toBeInTheDocument();
    });

    test('says when no line matches the filters', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'error' } });
      expect(screen.getByText('No log lines match these filters.')).toBeInTheDocument();
    });

    test('remembers the selected tab', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      expect(storedState().tab).toBe('raw');
    });

    test('opens on the tab it was left on', () => {
      seedState({ tab: 'raw' });
      render(<LiveActivityPanel />);
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('[LlamaService] Model configuration updated')).toBeInTheDocument();
    });

    test('clicking a row shows its full details; clicking again hides them', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));

      const row = screen.getByRole('button', { name: /Cannot access file/ });
      expect(row).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(row);
      expect(row).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('Selected log line details')).toHaveValue(
        '[DOWNLOAD-WATCHER] Cannot access file:\n{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      );

      fireEvent.click(screen.getByRole('button', { name: /Cannot access file/ }));
      expect(screen.queryByLabelText('Selected log line details')).not.toBeInTheDocument();
    });
  });

  describe('tabs keyboard', () => {
    test('arrow keys move between tabs and only the selected tab is in the tab order', () => {
      render(<LiveActivityPanel />);
      const activityTab = screen.getByRole('tab', { name: 'Activity' });
      const rawTab = screen.getByRole('tab', { name: 'Raw' });
      expect(activityTab).toHaveAttribute('tabindex', '0');
      expect(rawTab).toHaveAttribute('tabindex', '-1');

      activityTab.focus();
      fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
      expect(rawTab).toHaveAttribute('aria-selected', 'true');
      expect(rawTab).toHaveFocus();
      expect(storedState().tab).toBe('raw');

      fireEvent.keyDown(rawTab, { key: 'ArrowRight' });
      expect(activityTab).toHaveAttribute('aria-selected', 'true');
      expect(activityTab).toHaveFocus();

      fireEvent.keyDown(activityTab, { key: 'End' });
      expect(rawTab).toHaveFocus();
      fireEvent.keyDown(rawTab, { key: 'Home' });
      expect(activityTab).toHaveFocus();
    });

    test('the tab panel is labelled by the selected tab', () => {
      render(<LiveActivityPanel />);
      expect(screen.getByRole('tabpanel', { name: 'Activity' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      expect(screen.getByRole('tabpanel', { name: 'Raw' })).toBeInTheDocument();
    });
  });

  describe('Redact paths', () => {
    test('hides file names in both tabs', () => {
      mockState = { redactPaths: true };
      render(<LiveActivityPanel />);

      expect(screen.getByText('Analyzing a file')).toBeInTheDocument();
      expect(screen.queryByText(/receipt-0412/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      expect(
        screen.getByText('[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]')
      ).toBeInTheDocument();
      expect(screen.getByText('{"filePath":"a file"}')).toBeInTheDocument();
      expect(screen.queryByText(/tax\.pdf/)).not.toBeInTheDocument();
    });

    test('problem lines use their own redacted text', () => {
      mockState = { redactPaths: true };
      mockFeed = makeFeed({
        entries: [
          entry(20, {
            level: 'error',
            context: 'OrganizeService',
            activity: {
              kind: 'problem',
              icon: 'alert',
              tone: 'error',
              text: 'Problem: Could not move tax return.pdf',
              file: 'tax return.pdf',
              files: ['tax return.pdf'],
              redactedText: 'Problem: Could not move a file'
            }
          })
        ]
      });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Problem: Could not move a file')).toBeInTheDocument();
      expect(screen.queryByText(/tax return/)).not.toBeInTheDocument();
    });

    test('details of a selected row are redacted too', () => {
      mockState = { redactPaths: true };
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      fireEvent.click(screen.getByRole('button', { name: /Cannot access file/ }));
      expect(screen.getByLabelText('Selected log line details')).toHaveValue(
        '[DOWNLOAD-WATCHER] Cannot access file:\n{"filePath":"a file"}'
      );
    });
  });

  describe('controls', () => {
    test('pause asks the feed to hold new entries', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Pause live activity' }));
      expect(mockPause).toHaveBeenCalledTimes(1);
    });

    test('while paused it shows how many new entries are waiting, and resumes', () => {
      mockFeed = makeFeed({ paused: true, pausedCount: 3 });
      render(<LiveActivityPanel />);
      expect(screen.getByText('3 new')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Resume live activity' }));
      expect(mockResume).toHaveBeenCalledTimes(1);
    });

    test('clear empties the feed', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Clear live activity' }));
      expect(mockClear).toHaveBeenCalledTimes(1);
    });

    test('copy puts the visible lines on the clipboard and announces it', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
      try {
        render(<LiveActivityPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));

        await waitFor(() =>
          expect(writeText).toHaveBeenCalledWith(
            [
              '09:00:01 Analyzing receipt-0412.jpg',
              '09:00:02 Saved search index (files)',
              '09:00:03 Problem: Cannot access file: [DownloadWatcher]'
            ].join('\n')
          )
        );
        expect(await screen.findByText('Copied 3 lines')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Copied 3 lines');
      } finally {
        delete window.navigator.clipboard;
      }
    });

    test('copy in the Raw tab honors redaction', async () => {
      mockState = { redactPaths: true };
      mockFeed = makeFeed({ entries: [ENTRIES[2]] });
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
      try {
        render(<LiveActivityPanel />);
        fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
        fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));
        await waitFor(() =>
          expect(writeText).toHaveBeenCalledWith(
            '09:00:03 WARN  [DownloadWatcher] [DOWNLOAD-WATCHER] Cannot access file: {"filePath":"a file"}'
          )
        );
        expect(await screen.findByText('Copied 1 line')).toBeInTheDocument();
      } finally {
        delete window.navigator.clipboard;
      }
    });

    test('a failing clipboard says so', async () => {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) }
      });
      try {
        render(<LiveActivityPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));
        expect(await screen.findByText('Copy failed')).toBeInTheDocument();
      } finally {
        delete window.navigator.clipboard;
      }
    });

    test('the copy message goes away after a few seconds', async () => {
      jest.useFakeTimers();
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: jest.fn().mockResolvedValue(undefined) }
      });
      try {
        render(<LiveActivityPanel />);
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));
        });
        expect(screen.getByRole('status')).toHaveTextContent('Copied 3 lines');
        act(() => {
          jest.advanceTimersByTime(5000);
        });
        expect(screen.getByRole('status')).toHaveTextContent('');
      } finally {
        jest.useRealTimers();
        delete window.navigator.clipboard;
      }
    });

    test('follows new entries, stops when scrolled up, and "Jump to latest" resumes', () => {
      const { rerender } = render(<LiveActivityPanel />);
      expect(mockScrollToRow).toHaveBeenLastCalledWith({ index: 2, align: 'end' });

      const list = screen.getByTestId('virtual-list');
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      fireEvent.scroll(list);
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

      mockScrollToRow.mockClear();
      mockFeed = makeFeed({
        entries: [
          ...ENTRIES,
          entry(5, { activity: { kind: 'x', icon: 'check', tone: 'success', text: 'Done' } })
        ]
      });
      rerender(<LiveActivityPanel />);
      expect(mockScrollToRow).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
      expect(mockScrollToRow).toHaveBeenLastCalledWith({ index: 3, align: 'end' });
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    });

    test('scrolling back to the bottom resumes following', () => {
      render(<LiveActivityPanel />);
      const list = screen.getByTestId('virtual-list');
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      fireEvent.scroll(list);
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

      list.scrollTop = 800;
      fireEvent.scroll(list);
      expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    });

    test('keeps following when the list is full and the oldest entry drops off', () => {
      const { rerender } = render(<LiveActivityPanel />);
      mockScrollToRow.mockClear();
      mockFeed = makeFeed({
        entries: [
          ...ENTRIES.slice(1),
          entry(5, { activity: { kind: 'x', icon: 'check', tone: 'success', text: 'Done' } })
        ]
      });
      rerender(<LiveActivityPanel />);
      expect(mockScrollToRow).toHaveBeenLastCalledWith({ index: 2, align: 'end' });
    });

    test('reports entries skipped during a burst', () => {
      mockFeed = makeFeed({ dropped: 7 });
      render(<LiveActivityPanel />);
      expect(screen.getByText('7 skipped (too fast)')).toBeInTheDocument();
    });

    test('says when live activity is unavailable', () => {
      mockFeed = makeFeed({ status: 'unavailable', entries: [] });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Live activity unavailable')).toBeInTheDocument();
    });
  });

  describe('minimize, restore and close', () => {
    test('minimizes to a pill with a pulsing dot while active, and restores', () => {
      mockFeed = makeFeed({ recentlyActive: true });
      render(<LiveActivityPanel />);

      fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
      expect(region()).not.toBeInTheDocument();
      const dot = screen.getByTestId('live-activity-pulse');
      expect(dot).toHaveAttribute('data-active', 'true');
      expect(dot.className).toContain('motion-safe:animate-pulse');
      expect(storedState().minimized).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Restore live activity panel' }));
      expect(region()).toBeInTheDocument();
      expect(storedState().minimized).toBe(false);
    });

    test('focus follows minimize and restore', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
      expect(screen.getByRole('button', { name: 'Restore live activity panel' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Restore live activity panel' }));
      expect(dragHandle()).toHaveFocus();
    });

    test('does not take focus when it first opens', () => {
      render(<LiveActivityPanel />);
      expect(document.body).toHaveFocus();
    });

    test('the dot does not pulse when nothing happened in the last 3 s', () => {
      render(<LiveActivityPanel />);
      const dot = screen.getByTestId('live-activity-pulse');
      expect(dot).toHaveAttribute('data-active', 'false');
      expect(dot.className).not.toContain('animate-pulse');
    });

    test('opens minimized when it was left minimized', () => {
      seedState({ minimized: true });
      render(<LiveActivityPanel />);
      expect(
        screen.getByRole('button', { name: 'Restore live activity panel' })
      ).toBeInTheDocument();
      expect(region()).not.toBeInTheDocument();
    });

    test('close turns the setting off', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Close live activity panel' }));
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'test/setShowLiveActivity',
        payload: false
      });
    });
  });

  describe('drag handle', () => {
    test('is a focusable draggable group with keyboard instructions, not a button', () => {
      render(<LiveActivityPanel />);
      const handle = dragHandle();
      expect(handle).toHaveAttribute('tabindex', '0');
      expect(handle).toHaveAttribute('aria-roledescription', 'draggable');
      expect(handle.getAttribute('aria-label')).toMatch(/arrow keys move/i);
      expect(handle.getAttribute('aria-label')).toMatch(/shift/i);
      expect(
        screen.queryByRole('button', { name: /Move live activity panel/ })
      ).not.toBeInTheDocument();
    });

    test('the minimize and close buttons sit outside the handle', () => {
      render(<LiveActivityPanel />);
      const handle = dragHandle();
      expect(
        handle.contains(screen.getByRole('button', { name: 'Minimize live activity panel' }))
      ).toBe(false);
      expect(
        handle.contains(screen.getByRole('button', { name: 'Close live activity panel' }))
      ).toBe(false);
    });
  });

  describe('accessibility (axe, semantic rules; contrast is the e2e pass)', () => {
    // The panel is a fragment, not a page: landmark rules belong to the page audit.
    const AXE_OPTIONS = { rules: { region: { enabled: false } } };

    test('the Activity view has no violations', async () => {
      const { container } = render(<LiveActivityPanel />);
      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    test('the Raw view with an open row has no violations', async () => {
      const { container } = render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      fireEvent.click(screen.getByRole('button', { name: /Cannot access file/ }));
      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    test('the minimized pill has no violations', async () => {
      seedState({ minimized: true });
      const { container } = render(<LiveActivityPanel />);
      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });

  describe('position and size', () => {
    test('restores the saved geometry and persists keyboard moves', () => {
      seedState({ x: 100, y: 100, width: 400, height: 300 });
      render(<LiveActivityPanel />);
      expect(region()).toHaveStyle({
        left: '100px',
        top: '100px',
        width: '400px',
        height: '300px'
      });

      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });

      expect(region()).toHaveStyle({ left: '116px' });
      expect(storedState()).toEqual({
        x: 116,
        y: 100,
        width: 400,
        height: 300,
        minimized: false,
        tab: 'activity'
      });
    });

    test('stays inside the window and never shrinks below the minimum size', () => {
      seedState({ x: 780, y: 100, width: 400, height: 300 });
      render(<LiveActivityPanel />);

      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });
      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });
      expect(storedState().x).toBe(800);

      for (let i = 0; i < 6; i += 1) {
        fireEvent.keyDown(dragHandle(), { key: 'ArrowLeft', shiftKey: true });
      }
      expect(storedState().width).toBe(320);
    });

    test('a saved position outside a smaller window is pulled back in', () => {
      seedState({ x: 5000, y: 5000, width: 400, height: 300 });
      render(<LiveActivityPanel />);
      expect(region()).toHaveStyle({ left: '800px', top: '600px' });
    });

    test('keeps its position across minimize and restore', () => {
      seedState({ x: 100, y: 100, width: 400, height: 300 });
      render(<LiveActivityPanel />);
      fireEvent.keyDown(dragHandle(), { key: 'ArrowDown' });
      fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Restore live activity panel' }));
      expect(region()).toHaveStyle({ left: '100px', top: '116px' });
      expect(storedState()).toMatchObject({ x: 100, y: 116, minimized: false });
    });

    test('works when localStorage throws', () => {
      const getSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const setSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      try {
        render(<LiveActivityPanel />);
        expect(region()).toHaveStyle({ left: '764px', top: '564px' });

        expect(() => fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' })).not.toThrow();
        expect(region()).toHaveStyle({ left: '780px' });

        fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
        expect(
          screen.getByRole('button', { name: 'Restore live activity panel' })
        ).toBeInTheDocument();
      } finally {
        getSpy.mockRestore();
        setSpy.mockRestore();
      }
    });
  });
});
