import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import PropTypes from 'prop-types';
import { List } from 'react-window';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  FileSearch,
  FolderInput,
  HardDrive,
  Minus,
  Pause,
  Play,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  X
} from 'lucide-react';
import { useNotification } from '../../contexts/NotificationContext';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { selectRedactPaths } from '../../store/selectors';
import { setShowLiveActivity } from '../../store/thunks/liveActivityThunks';
import { MAX_RENDERER_ENTRIES, useLiveLogFeed } from '../../hooks/useLiveLogFeed';
import { getViewport, useDraggablePanel } from '../../hooks/useDraggablePanel';
import { loadPanelState, savePanelState } from './liveActivityPanelState';
import {
  LEVEL_FILTER_OPTIONS,
  activityContextTag,
  activityEntries,
  filterRawEntries,
  formatCopyLine,
  formatEntryTime,
  listContexts,
  pickActivityIcon,
  redactActivityText,
  redactRawText
} from './liveActivityFormat';

/**
 * Live Activity panel: a floating, draggable, minimizable card showing what
 * the app is doing (Activity tab) and the sanitized log lines (Raw tab).
 * Mounted by App.js while the `showLiveActivity` setting is on; Close turns
 * that setting off. Layout (position, size, minimized, tab) is per-machine
 * UI state in localStorage (liveActivityPanelState.js).
 *
 * Text colors use the neutral gray ink ramp: 500 meets 4.5:1 on the panel
 * surface and gray-100 (hover), but not on gray-200, so text that can sit on
 * gray-200 (badges, tags, the selected Raw row) uses 600 or darker. Level and
 * tone colors are carried by icons and badge tints only, so nothing depends
 * on brand-colored small text for contrast.
 * The pulse uses `motion-safe:` and the global reduced-motion rule in
 * styles.css, so it never animates under prefers-reduced-motion.
 */

const ROW_HEIGHT = 28;
const DETAILS_HEIGHT = 88;
const COPY_STATUS_MS = 4000;
const LIST_STYLE = Object.freeze({ height: '100%', width: '100%' });
const NO_CONTEXTS = Object.freeze([]);

const ACTIVITY_ICONS = Object.freeze({
  analyze: FileSearch,
  check: CheckCircle2,
  sparkles: Sparkles,
  folder: FolderInput,
  eye: Eye,
  cpu: Cpu,
  database: Database,
  save: Save,
  'hard-drive': HardDrive,
  alert: AlertTriangle,
  undo: Undo2,
  download: Download,
  search: Search,
  wrench: Wrench
});

const TONE_CLASS = {
  info: 'text-system-gray-400',
  success: 'text-stratosort-success',
  warn: 'text-stratosort-warning',
  error: 'text-stratosort-danger'
};

// Tinted backgrounds carry the level color; the ink stays neutral for contrast.
const LEVEL_BADGE_CLASS = {
  trace: 'bg-system-gray-200 text-system-gray-700',
  debug: 'bg-system-gray-200 text-system-gray-700',
  info: 'bg-stratosort-blue/15 text-system-gray-800',
  warn: 'bg-stratosort-warning/25 text-system-gray-900',
  error: 'bg-stratosort-danger/25 text-system-gray-900',
  fatal: 'bg-stratosort-danger/25 text-system-gray-900'
};

/** @type {ReadonlyArray<{ value: 'activity' | 'raw', label: string }>} */
const TABS = Object.freeze([
  { value: 'activity', label: 'Activity' },
  { value: 'raw', label: 'Raw' }
]);

const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/80';

function PulseDot({ active }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-activity-pulse"
      data-active={active ? 'true' : 'false'}
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
        active ? 'bg-stratosort-success motion-safe:animate-pulse' : 'bg-system-gray-400'
      }`}
    />
  );
}

PulseDot.propTypes = {
  active: PropTypes.bool.isRequired
};

/** A compact icon-only button sized for the 36px toolbar (ui/IconButton starts at 36px). */
function ToolbarButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-system-gray-700 hover:bg-system-gray-200 hover:text-system-gray-900 ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

ToolbarButton.propTypes = {
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  children: PropTypes.node.isRequired
};

function ActivityRow({ index, style, ariaAttributes, rows, redact }) {
  const entry = rows[index];
  if (!entry || !entry.activity) return <div style={style} {...ariaAttributes} />;
  const Icon = pickActivityIcon(ACTIVITY_ICONS, entry.activity.icon, Activity);
  const text = redactActivityText(entry.activity, redact);
  const tag = activityContextTag(entry);
  return (
    <div style={style} {...ariaAttributes} className="flex items-center gap-2 px-3 text-xs">
      <span className="flex-shrink-0 font-mono tabular-nums text-system-gray-500">
        {formatEntryTime(entry.time)}
      </span>
      <Icon
        aria-hidden="true"
        className={`h-3.5 w-3.5 flex-shrink-0 ${TONE_CLASS[entry.activity.tone] || TONE_CLASS.info}`}
      />
      <span className="min-w-0 truncate text-system-gray-900" title={text}>
        {text}
      </span>
      {tag ? (
        <span className="ml-auto flex-shrink-0 rounded bg-system-gray-200 px-1 font-mono text-system-gray-700">
          {tag}
        </span>
      ) : null}
    </div>
  );
}

ActivityRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  ariaAttributes: PropTypes.object,
  rows: PropTypes.array.isRequired,
  redact: PropTypes.bool.isRequired
};

function RawRow({ index, style, ariaAttributes, rows, redact, selectedId, onSelect }) {
  const entry = rows[index];
  if (!entry) return <div style={style} {...ariaAttributes} />;
  const msg = redactRawText(entry.msg, redact);
  const dataText = redactRawText(entry.dataText, redact);
  const selected = selectedId === entry.id;
  return (
    <div style={style} {...ariaAttributes}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(entry.id)}
        className={`flex h-full w-full items-center gap-2 px-3 text-left font-mono text-xs hover:bg-system-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stratosort-blue/80 ${
          selected ? 'bg-system-gray-200' : ''
        }`}
      >
        <span className="flex-shrink-0 tabular-nums text-system-gray-600">
          {formatEntryTime(entry.time)}
        </span>
        <span
          className={`flex-shrink-0 rounded px-1 uppercase ${
            LEVEL_BADGE_CLASS[entry.level] || LEVEL_BADGE_CLASS.info
          }`}
        >
          {entry.level}
        </span>
        <span className="flex-shrink-0 text-system-gray-600">{entry.context || 'App'}</span>
        <span className="min-w-0 truncate text-system-gray-900">{msg}</span>
        {dataText ? (
          <span className="min-w-0 flex-1 truncate text-system-gray-600">{dataText}</span>
        ) : null}
      </button>
    </div>
  );
}

RawRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  ariaAttributes: PropTypes.object,
  rows: PropTypes.array.isRequired,
  redact: PropTypes.bool.isRequired,
  selectedId: PropTypes.number,
  onSelect: PropTypes.func.isRequired
};

function LiveActivityPanel() {
  const dispatch = useAppDispatch();
  const { addNotification } = useNotification();
  // The selector stays true until the setting has loaded (privacy-safe).
  const redactPaths = useAppSelector(selectRedactPaths) === true;
  const feed = useLiveLogFeed({ enabled: true });
  const idBase = useId();
  const listRef = useRef(null);
  const handleRef = useRef(null);
  const pillRef = useRef(null);
  const tabRefs = useRef({});
  /** Where focus goes after the next minimize/restore render (never on mount). */
  const pendingFocusRef = useRef(null);

  const [panelState, setPanelState] = useState(() => loadPanelState(getViewport()));
  const panelStateRef = useRef(panelState);
  const persist = useCallback((patch) => {
    const next = { ...panelStateRef.current, ...patch };
    panelStateRef.current = next;
    setPanelState(next);
    savePanelState(next);
  }, []);

  const { geometry, dragHandleProps, resizeHandleProps } = useDraggablePanel({
    initialGeometry: {
      x: panelState.x,
      y: panelState.y,
      width: panelState.width,
      height: panelState.height
    },
    onCommit: persist
  });

  const [minLevel, setMinLevel] = useState('debug');
  const [contextFilter, setContextFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');

  const { tab, minimized } = panelState;

  const visible = useMemo(
    () =>
      tab === 'raw'
        ? filterRawEntries(feed.entries, minLevel, contextFilter)
        : activityEntries(feed.entries),
    [feed.entries, tab, minLevel, contextFilter]
  );
  const lastVisibleId = visible.length > 0 ? visible[visible.length - 1].id : null;

  const contextOptions = useMemo(() => {
    if (tab !== 'raw') return NO_CONTEXTS;
    const contexts = listContexts(feed.entries);
    // Keep a chosen context selectable after its entries are cleared or capped away.
    return contextFilter !== 'all' && !contexts.includes(contextFilter)
      ? [...contexts, contextFilter]
      : contexts;
  }, [tab, feed.entries, contextFilter]);

  const selectedEntry =
    tab === 'raw' && selectedId !== null
      ? visible.find((candidate) => candidate.id === selectedId) || null
      : null;

  const scrollToLatest = useCallback((count) => {
    if (count <= 0) return;
    try {
      listRef.current?.scrollToRow?.({ index: count - 1, align: 'end' });
    } catch {
      // The list is between renders (index out of range); the next update scrolls.
    }
  }, []);

  // Follow the newest entry while auto-scroll is on. Keyed by the last id, not
  // the count, so it keeps following once the list is full and the oldest
  // entry drops off each time a new one arrives.
  useEffect(() => {
    if (!autoScroll || minimized) return;
    scrollToLatest(visible.length);
  }, [autoScroll, minimized, lastVisibleId, visible.length, tab, scrollToLatest]);

  // Scrolled up with the list full, each batch drops the oldest rows from the
  // head and every row moves up under the reader. Keep their place: move the
  // scroll position up by the rows that left the head. Only for feed
  // updates; a tab or filter change is a new list, not a shifted one.
  const anchorRef = useRef({ visible, view: '' });
  const adjustingScrollRef = useRef(false);
  const view = [tab, minLevel, contextFilter].join('|');
  useLayoutEffect(() => {
    const previous = anchorRef.current;
    anchorRef.current = { visible, view };
    if (autoScroll || minimized || previous.view !== view) return;
    const before = previous.visible;
    if (before === visible || before.length === 0 || visible.length === 0) return;
    const firstId = visible[0].id;
    if (before[0].id === firstId) return;
    const removed = before.findIndex((candidate) => candidate.id === firstId);
    if (removed <= 0) return;
    const element = listRef.current?.element;
    if (!element) return;
    const nextTop = Math.max(0, element.scrollTop - removed * ROW_HEIGHT);
    if (nextTop === element.scrollTop) return;
    adjustingScrollRef.current = true;
    element.scrollTop = nextTop;
  }, [visible, view, autoScroll, minimized]);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    (target === 'pill' ? pillRef.current : handleRef.current)?.focus();
  }, [minimized]);

  useEffect(() => {
    if (!copyStatus) return undefined;
    const timer = setTimeout(() => setCopyStatus(''), COPY_STATUS_MS);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const handleScroll = useCallback((event) => {
    const element = event.currentTarget;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= ROW_HEIGHT / 2;
    if (adjustingScrollRef.current) {
      // The scroll the place-keeping above caused: it may stop following, never start it.
      adjustingScrollRef.current = false;
      if (!atBottom) setAutoScroll(false);
      return;
    }
    setAutoScroll(atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    setAutoScroll(true);
    scrollToLatest(visible.length);
  }, [scrollToLatest, visible.length]);

  const handleSelect = useCallback((id) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  const selectTab = useCallback(
    (next) => {
      if (next === panelStateRef.current.tab) return;
      setSelectedId(null);
      setAutoScroll(true);
      persist({ tab: next });
    },
    [persist]
  );

  const handleTabKeyDown = useCallback(
    (event) => {
      const current = TABS.findIndex((candidate) => candidate.value === tab);
      let nextIndex = -1;
      if (event.key === 'ArrowRight') nextIndex = (current + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') nextIndex = (current - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = TABS.length - 1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const next = TABS[nextIndex].value;
      selectTab(next);
      tabRefs.current[next]?.focus();
    },
    [tab, selectTab]
  );

  const handleMinimize = useCallback(() => {
    pendingFocusRef.current = 'pill';
    persist({ minimized: true });
  }, [persist]);

  const handleRestore = useCallback(() => {
    pendingFocusRef.current = 'handle';
    persist({ minimized: false });
  }, [persist]);

  const handleClose = useCallback(async () => {
    // The thunk hides the panel at once and puts it back if the save fails,
    // so a failed save would otherwise only look like the panel reopening.
    // Same grouped toast as the Diagnostics switch: repeated failures update
    // one toast in place. The provider outlives this panel's unmount.
    const saved = await dispatch(setShowLiveActivity(false));
    if (saved === false) {
      addNotification(
        "Couldn't save the live activity setting",
        'error',
        6000,
        'live-activity-save-error'
      );
    }
  }, [addNotification, dispatch]);

  const { clear: clearFeed } = feed;
  const handleClear = useCallback(() => {
    clearFeed();
    setSelectedId(null);
    setAutoScroll(true);
    setCopyStatus('');
  }, [clearFeed]);

  const handleCopy = useCallback(async () => {
    if (visible.length === 0) {
      setCopyStatus('Nothing to copy');
      return;
    }
    const text = visible.map((candidate) => formatCopyLine(candidate, tab, redactPaths)).join('\n');
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setCopyStatus('Copy is unavailable');
      return;
    }
    try {
      await clipboard.writeText(text);
      setCopyStatus(`Copied ${visible.length} ${visible.length === 1 ? 'line' : 'lines'}`);
    } catch {
      setCopyStatus('Copy failed');
    }
  }, [visible, tab, redactPaths]);

  const rowProps = useMemo(
    () =>
      tab === 'raw'
        ? { rows: visible, redact: redactPaths, selectedId, onSelect: handleSelect }
        : { rows: visible, redact: redactPaths },
    [tab, visible, redactPaths, selectedId, handleSelect]
  );

  if (minimized) {
    return (
      <button
        ref={pillRef}
        type="button"
        aria-label="Restore live activity panel"
        title="Restore live activity panel"
        onClick={handleRestore}
        className={`fixed bottom-4 right-4 z-floating-panel inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface-primary px-3 py-1.5 text-xs font-medium text-system-gray-900 shadow-lg ${FOCUS_RING}`}
      >
        <PulseDot active={feed.recentlyActive} />
        Live activity
      </button>
    );
  }

  let connectionText = `${visible.length} shown`;
  if (feed.status === 'connecting') connectionText = 'Connecting…';
  else if (feed.status === 'unavailable') connectionText = 'Not connected';
  else if (feed.paused) connectionText = 'Paused';

  const panelId = `${idBase}-panel`;
  const tabId = (value) => `${idBase}-tab-${value}`;

  let body;
  if (feed.status === 'unavailable') {
    body = (
      <p className="flex items-center gap-2 p-4 text-sm text-system-gray-900">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-stratosort-danger" />
        Live activity unavailable
      </p>
    );
  } else if (visible.length === 0) {
    body = (
      <p className="p-4 text-sm text-system-gray-500">
        {tab === 'raw' && feed.entries.length > 0
          ? 'No log lines match these filters.'
          : 'Waiting for activity…'}
      </p>
    );
  } else {
    body = (
      <div className="min-h-0 flex-1">
        <List
          listRef={listRef}
          rowCount={visible.length}
          rowHeight={ROW_HEIGHT}
          rowComponent={tab === 'raw' ? RawRow : ActivityRow}
          rowProps={rowProps}
          overscanCount={8}
          defaultHeight={Math.max(ROW_HEIGHT * 2, geometry.height - 110)}
          onScroll={handleScroll}
          tabIndex={0}
          aria-label={tab === 'raw' ? 'Raw log lines' : 'Activity entries'}
          className="scrollbar-thin focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stratosort-blue/80"
          style={LIST_STYLE}
        />
      </div>
    );
  }

  return (
    <section
      aria-label="Live activity"
      className="fixed z-floating-panel flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-primary shadow-lg"
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height
      }}
    >
      <div className="flex h-10 flex-shrink-0 items-center gap-1 border-b border-border-soft pl-2 pr-1">
        {/* Not a button: it has no Enter/Space action. Pointer drag moves it;
            arrow keys move it and Shift+arrows resize it (useDraggablePanel). */}
        <div
          ref={handleRef}
          role="group"
          aria-roledescription="draggable"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard move/resize target (arrows move, Shift+arrows resize); ARIA has no draggable widget role
          tabIndex={0}
          aria-label="Move live activity panel. Arrow keys move it; Shift plus arrow keys resize it."
          title="Drag to move. Arrow keys move; Shift+arrow keys resize."
          {...dragHandleProps}
          className={`flex h-8 min-w-0 flex-1 cursor-move select-none items-center gap-2 rounded px-1 ${FOCUS_RING}`}
          style={{ touchAction: 'none' }}
        >
          <PulseDot active={feed.recentlyActive} />
          <span className="truncate text-sm font-medium text-system-gray-900">Live activity</span>
        </div>
        <ToolbarButton label="Minimize live activity panel" onClick={handleMinimize}>
          <Minus aria-hidden="true" className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton label="Close live activity panel" onClick={handleClose}>
          <X aria-hidden="true" className="h-4 w-4" />
        </ToolbarButton>
      </div>

      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border-soft px-2">
        <div role="tablist" aria-label="Live activity view" className="flex gap-1">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              ref={(node) => {
                tabRefs.current[value] = node;
              }}
              type="button"
              role="tab"
              id={tabId(value)}
              aria-selected={tab === value}
              aria-controls={panelId}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => selectTab(value)}
              onKeyDown={handleTabKeyDown}
              className={`rounded-md px-2 py-1 text-xs font-medium ${FOCUS_RING} ${
                tab === value
                  ? 'bg-stratosort-blue/15 text-system-gray-900'
                  : 'text-system-gray-600 hover:bg-system-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'raw' ? (
          <>
            <select
              aria-label="Minimum level"
              title="Minimum level"
              value={minLevel}
              onChange={(event) => setMinLevel(event.target.value)}
              className="h-7 rounded-md border border-border-soft bg-surface-primary px-1 text-xs text-system-gray-900"
            >
              {LEVEL_FILTER_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <select
              aria-label="Context"
              title="Context"
              value={contextFilter}
              onChange={(event) => setContextFilter(event.target.value)}
              className="h-7 min-w-0 max-w-[8rem] truncate rounded-md border border-border-soft bg-surface-primary px-1 text-xs text-system-gray-900"
            >
              <option value="all">All contexts</option>
              {contextOptions.map((context) => (
                <option key={context} value={context}>
                  {context}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {feed.paused && feed.pausedCount > 0 ? (
            <span className="text-xs text-system-gray-700">
              {feed.pausedCount >= MAX_RENDERER_ENTRIES
                ? MAX_RENDERER_ENTRIES + '+'
                : feed.pausedCount}{' '}
              new
            </span>
          ) : null}
          <ToolbarButton
            label={feed.paused ? 'Resume live activity' : 'Pause live activity'}
            onClick={feed.paused ? feed.resume : feed.pause}
          >
            {feed.paused ? (
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Pause aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </ToolbarButton>
          <ToolbarButton label="Copy visible lines" onClick={handleCopy}>
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Clear live activity" onClick={handleClear}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body}
        {selectedEntry ? (
          <div
            className="flex-shrink-0 border-t border-border-soft p-2"
            style={{ height: DETAILS_HEIGHT }}
          >
            <textarea
              readOnly
              aria-label="Selected log line details"
              value={[
                redactRawText(selectedEntry.msg, redactPaths),
                redactRawText(selectedEntry.dataText, redactPaths)
              ]
                .filter(Boolean)
                .join('\n')}
              className={`h-full w-full resize-none rounded bg-transparent font-mono text-xs text-system-gray-800 ${FOCUS_RING}`}
            />
          </div>
        ) : null}
      </div>

      <div className="flex h-6 flex-shrink-0 items-center gap-2 border-t border-border-soft px-3 pr-4 text-xs text-system-gray-500">
        <span>{connectionText}</span>
        {feed.dropped > 0 ? <span>{feed.dropped} skipped (too fast)</span> : null}
        {/* Always mounted so screen readers announce the copy result. */}
        <span role="status" className="min-w-0 truncate text-system-gray-700">
          {copyStatus}
        </span>
        {!autoScroll && visible.length > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className={`ml-auto inline-flex items-center gap-1 rounded text-system-gray-800 underline-offset-2 hover:underline ${FOCUS_RING}`}
          >
            <ArrowDownToLine aria-hidden="true" className="h-3 w-3" />
            Jump to latest
          </button>
        ) : null}
      </div>

      <div
        aria-hidden="true"
        data-testid="live-activity-resize"
        title="Drag to resize"
        {...resizeHandleProps}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize border-b-2 border-r-2 border-system-gray-400"
        style={{ touchAction: 'none' }}
      />
    </section>
  );
}

export default LiveActivityPanel;
