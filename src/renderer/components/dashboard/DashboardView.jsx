import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import { motion, useReducedMotion, useMotionValue, useTransform, animate } from 'framer-motion';
import {
  FolderUp,
  FilePlus,
  FolderPlus,
  FolderTree,
  Sparkles,
  ArrowRight,
  FolderInput,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  setPhase,
  setViewMode,
  setCameFromDashboard,
  canTransitionTo
} from '../../store/slices/uiSlice';
import {
  selectFileStats,
  selectSmartFolders,
  selectOrganizedFiles,
  selectOrganizedCount,
  selectFilesWithAnalysis,
  selectIsAnalyzing,
  selectAnalysisProgress,
  selectRedactPaths
} from '../../store/selectors';
import { formatDisplayFileName } from '../../utils/pathDisplay';
import { TIMEOUTS } from '../../../shared/performanceConstants';
import { dispatchAcked } from '../../utils/dispatchAcked';
import { useDragAndDrop } from '../../hooks/useDragAndDrop';
import Card from '../ui/Card';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import AlertBox from '../ui/AlertBox';
import StateMessage from '../ui/StateMessage';
import Stack from '../layout/Stack';
import { Heading, Text, Caption } from '../ui/Typography';
import AnalysisProgress from '../discover/AnalysisProgress';
import KnowledgeStatsCard from './KnowledgeStatsCard';

const RECENT_LIMIT = 4;
const QUEUE_PREVIEW_LIMIT = 4;
const FOLDER_CHIP_LIMIT = 8;

// Entrance motion mirrors the app's established language (see PhaseRenderer /
// CompletePhase): the emphasized ease, a short duration, and a small per-block
// stagger so the dashboard assembles itself instead of snapping in flat. Frozen
// at module scope so the objects aren't re-allocated on every render. The
// reduced-motion variants drop the vertical travel and collapse to a fast fade.
const STAGGER_VARIANTS = Object.freeze({
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.02 } }
});
const BLOCK_VARIANTS = Object.freeze({
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }
});
const BLOCK_VARIANTS_REDUCED = Object.freeze({
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.08, ease: [0.22, 1, 0.36, 1] } }
});

// Controlled semantic palette for the pipeline stages: the dashboard stays calm
// and neutral while empty, then "lights up" in meaning as work flows through —
// amber = awaiting, blue = ready, green = organized. A stage at zero recedes to
// muted gray (the number) over a soft neutral-blue chip (the icon) so an empty
// board reads as a calm invitation, never as gray dead space.
const STAGE_TONE = Object.freeze({
  warning: {
    text: 'text-stratosort-warning',
    icon: 'bg-stratosort-warning/12 text-stratosort-warning'
  },
  accent: { text: 'text-stratosort-blue', icon: 'bg-stratosort-blue/12 text-stratosort-blue' },
  success: {
    text: 'text-stratosort-success',
    icon: 'bg-stratosort-success/12 text-stratosort-success'
  }
});
const STAGE_ICON_NEUTRAL = 'bg-stratosort-blue/8 text-stratosort-blue/80';

// Quick-action tiles each carry their own accent so the row reads with rhythm
// instead of three identical blue chips.
const ACTION_TONE = Object.freeze({
  blue: 'bg-stratosort-blue/12 text-stratosort-blue',
  green: 'bg-stratosort-success/12 text-stratosort-success',
  amber: 'bg-stratosort-warning/12 text-stratosort-warning'
});

// DashboardView and DiscoverPhase are never mounted together — App.js renders
// one or the other. So the dashboard can't run the file pipeline itself; it
// navigates to the discover surface and then fires a window CustomEvent that
// DiscoverPhase's listeners pick up via dispatchAcked, which retries at this
// interval until the (lazy) DiscoverPhase chunk has mounted its listeners —
// a single fixed delay dropped the action on cold renderers (same pattern as
// useKeyboardShortcuts' dispatchDiscoverEvent).
const PICKER_BRIDGE_DELAY = TIMEOUTS.WINDOW_LOAD_DELAY || 100;

// Section headers need to rank one tier above body copy so the eye can pick out
// the pipeline / quick-actions / smart-folders blocks at a glance. Caption bakes
// in text-xs + gray-500, and a className color override can't reliably win the
// Tailwind cascade — so write the classes directly here instead. Rendered as a
// real h2 (under HeroBand's h1) so the sections exist in the screen-reader
// outline; preflight zeroes heading font/margin so pixels match the old span.
function SectionLabel({ children }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wide text-system-gray-700">
      {children}
    </h2>
  );
}

SectionLabel.propTypes = {
  children: PropTypes.node.isRequired
};

/**
 * HeroBand — left-aligned masthead. It pairs an adaptive status pill + at-a-glance
 * summary with the two primary entry points (import a folder / add files). The
 * left alignment deliberately contrasts with the centered, step-numbered wizard.
 */
function HeroBand({ status, greeting, summary, onImport, onAdd }) {
  const StatusIcon = status.icon;
  return (
    <Card variant="hero" className="relative overflow-hidden">
      {/* Brand-gradient glow layer: gives the hero depth + warmth so it reads as
          the lead surface, distinct from the flat secondary cards. Two layered
          radials deliberately echo the splash screen (index.html) — a brand-teal
          glow anchored top-left behind the eyebrow + a faint amber accent
          top-right — so the dashboard feels continuous with app launch. Sits over
          the glass-panel base (which supplies the translucent fill) rather than
          replacing it, and never intercepts pointer events. No backdrop-blur
          (disabled globally on Windows/Electron). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(125% 145% at 0% 0%, rgba(59, 160, 192, 0.16), transparent 55%), radial-gradient(90% 130% at 100% 0%, rgba(224, 160, 32, 0.10), transparent 50%)'
        }}
      />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-2xl">
          <div className="flex flex-wrap items-center gap-compact">
            <Caption className="text-stratosort-blue">Dashboard</Caption>
            <StatusBadge variant={status.variant} size="sm">
              <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {status.label}
            </StatusBadge>
          </div>
          {/* as="h1": Heading defaults to an h2 tag, which left the dashboard
              with no real h1 — the hero greeting IS the page title. variant
              already carried the h1 look, so pixels are unchanged. */}
          <Heading as="h1" variant="h1" className="mt-2">
            {/* Gradient-clipped greeting echoing the splash wordmark: light on the
                left for contrast, resolving into brand teal. The gradient classes
                live on this span (not the Heading) so its own text-transparent
                wins cleanly instead of fighting Heading's baked text color. */}
            <span className="bg-gradient-to-r from-system-gray-900 via-system-gray-800 to-stratosort-blue bg-clip-text text-transparent">
              {greeting}
            </span>
          </Heading>
          <Text variant="small" className="mt-1">
            {summary}
          </Text>
        </div>
        <div className="flex shrink-0 flex-col gap-compact sm:flex-row">
          <Button
            variant="secondary"
            size="lg"
            onClick={onImport}
            leftIcon={<FolderUp className="h-5 w-5" />}
          >
            Import folder
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={onAdd}
            leftIcon={<FilePlus className="h-5 w-5" />}
          >
            Add files
          </Button>
        </div>
      </div>
    </Card>
  );
}

HeroBand.propTypes = {
  status: PropTypes.shape({
    label: PropTypes.string.isRequired,
    variant: PropTypes.string.isRequired,
    icon: PropTypes.elementType.isRequired
  }).isRequired,
  greeting: PropTypes.string.isRequired,
  summary: PropTypes.string.isRequired,
  onImport: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired
};

// Count-up readout for the pipeline tallies: the number rolls from 0 to its
// value on mount (and tweens between values on change) so the pipeline reads
// like an instrument powering on alongside the staggered entrance. Rendered via
// a framer MotionValue child so each frame writes textContent directly without
// triggering a React re-render. Reduced motion snaps straight to the final value
// (the motion value is seeded at the target and the effect is a no-op).
const COUNT_UP_DURATION = 0.6;
function AnimatedCount({ value }) {
  const reduceMotion = useReducedMotion();
  const motionValue = useMotionValue(reduceMotion ? value : 0);
  const text = useTransform(motionValue, (latest) => Math.round(latest).toString());
  useEffect(() => {
    if (reduceMotion) {
      motionValue.set(value);
      return undefined;
    }
    const controls = animate(motionValue, value, {
      duration: COUNT_UP_DURATION,
      ease: [0.22, 1, 0.36, 1]
    });
    return () => controls.stop();
  }, [value, reduceMotion, motionValue]);
  return <motion.span>{text}</motion.span>;
}

AnimatedCount.propTypes = {
  value: PropTypes.number.isRequired
};

function PipelineStage({ icon: Icon, label, value, tone, isEntryHint, onClick }) {
  // Invert the emphasis: an empty stage recedes (the number drops to muted gray,
  // the chip to a calm neutral blue) while a live count lights up in the stage's
  // semantic tone. The big number is written with explicit utilities rather than
  // a Heading so the tone color can't lose the Tailwind cascade to a baked-in
  // text-system-gray-900 (same reasoning as SectionLabel above).
  const isZero = value === 0;
  const palette = STAGE_TONE[tone] || STAGE_TONE.accent;
  const valueClass = isZero ? 'text-system-gray-500' : palette.text;
  const iconClass = isZero ? STAGE_ICON_NEUTRAL : palette.icon;
  const interactive = typeof onClick === 'function' && value > 0;
  const Wrapper = interactive ? 'button' : 'div';
  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={interactive ? onClick : undefined}
      className={`group/stage flex min-w-0 flex-1 flex-col items-center text-center ${
        interactive
          ? 'cursor-pointer rounded-xl transition-colors hover:bg-system-gray-100/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/40'
          : ''
      }`.trim()}
    >
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-200 ease-out ${iconClass} ${
          isEntryHint ? 'ring-2 ring-stratosort-blue/25' : ''
        } ${interactive ? 'group-hover/stage:scale-110' : ''}`.trim()}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div
        className={`mt-2 font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums ${valueClass}`}
      >
        <AnimatedCount value={value} />
      </div>
      <Text variant="tiny" className="mt-1">
        {label}
      </Text>
    </Wrapper>
  );
}

PipelineStage.propTypes = {
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
  tone: PropTypes.oneOf(['warning', 'accent', 'success']),
  isEntryHint: PropTypes.bool,
  onClick: PropTypes.func
};

/**
 * PipelineCard — the dashboard's centerpiece. Renders the three lifecycle stages
 * (awaiting → ready → organized) as a full-width left-to-right flow, with the
 * "in flight" tally and a Failed indicator sharing the footer. Failed only
 * becomes an actionable control when something has actually failed; otherwise it
 * recedes to a quiet "0 failed" so the calm state reads as calm. The smart-folder
 * count lives in the hero summary and the Smart Folders section, so it is not
 * repeated here.
 */
function PipelineCard({
  stats,
  organizedCount,
  onReviewFailed,
  onPendingStage,
  onReadyStage,
  onOrganizedStage,
  className
}) {
  const reduceMotion = useReducedMotion();
  const inFlight = stats.pending + stats.ready;
  const isEmpty = stats.total === 0 && organizedCount === 0;
  // Weighted progress: pending = 0%, ready = halfway, organized = complete. This
  // keeps the connector rail alive while files move through analysis, not only
  // after the first organize confirmation.
  const denom = stats.pending + stats.ready + organizedCount;
  const weightedProgress = stats.ready * 0.5 + organizedCount;
  const railPct = denom > 0 ? Math.round((weightedProgress / denom) * 100) : 0;
  return (
    <Card variant="default" className={className}>
      <div className="flex items-center justify-between gap-cozy">
        <SectionLabel>Organization pipeline</SectionLabel>
        <StatusBadge variant={inFlight > 0 ? 'info' : 'success'} size="sm">
          {inFlight > 0 ? `${inFlight} in progress` : 'All clear'}
        </StatusBadge>
      </div>
      {/* The three lifecycle stages sit on a single connector rail so the card
          reads as a left-to-right flow, not three disconnected boxes. The track
          spans icon-center to icon-center (each of three equal columns centers
          its icon at 1/6, 1/2, 5/6 of the width); the success-tinted fill grows
          toward the Organized node as work completes. */}
      <div className="relative mt-4 rounded-xl border border-border-soft/50 bg-system-gray-100/25 p-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-[16.66%] right-[16.66%] top-9 h-0.5 -translate-y-1/2 overflow-hidden rounded-full bg-system-gray-200/80"
        >
          <motion.div
            className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-stratosort-warning/70 via-stratosort-blue/80 to-stratosort-success"
            initial={reduceMotion ? false : { width: '0%' }}
            animate={{ width: `${railPct}%` }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Travelling sheen only while work is actually moving — silenced under
                reduced motion by the utility's own media query (styles.css). */}
            {inFlight > 0 ? <span aria-hidden="true" className="pipeline-rail-sheen" /> : null}
          </motion.div>
        </div>
        <div className="relative z-10 flex items-start justify-between gap-compact">
          <PipelineStage
            icon={Sparkles}
            label="Awaiting analysis"
            value={stats.pending}
            tone="warning"
            isEntryHint={isEmpty}
            onClick={onPendingStage}
          />
          <PipelineStage
            icon={FolderInput}
            label="Ready to organize"
            value={stats.ready}
            tone="accent"
            onClick={onReadyStage}
          />
          <PipelineStage
            icon={CheckCircle2}
            label="Organized"
            value={organizedCount}
            tone="success"
            onClick={onOrganizedStage}
          />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-cozy lg:mt-auto lg:pt-4">
        <Text variant="tiny">{`${inFlight} of ${stats.total} files in flight`}</Text>
        {stats.failed > 0 ? (
          <Button variant="ghost" size="sm" onClick={onReviewFailed}>
            <span className="inline-flex items-center gap-1.5 text-stratosort-danger">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {`${stats.failed} failed`}
            </span>
          </Button>
        ) : (
          <Text variant="tiny">0 failed</Text>
        )}
      </div>
    </Card>
  );
}

PipelineCard.propTypes = {
  stats: PropTypes.shape({
    total: PropTypes.number.isRequired,
    pending: PropTypes.number.isRequired,
    ready: PropTypes.number.isRequired,
    failed: PropTypes.number.isRequired
  }).isRequired,
  organizedCount: PropTypes.number.isRequired,
  onReviewFailed: PropTypes.func.isRequired,
  onPendingStage: PropTypes.func,
  onReadyStage: PropTypes.func,
  onOrganizedStage: PropTypes.func,
  className: PropTypes.string
};

function SmartFoldersCard({ folders, onManage, className }) {
  const visible = folders.slice(0, FOLDER_CHIP_LIMIT);
  const overflow = folders.length - visible.length;
  return (
    <Card variant="default" className={className}>
      <div className="flex items-center justify-between gap-cozy">
        <SectionLabel>Smart folders</SectionLabel>
        <Button variant="ghost" size="sm" onClick={onManage}>
          Manage
        </Button>
      </div>
      {/* Responsive tile grid instead of small pills: tiles grow to fill the
          card width (2 cols, 3 on large) AND its height. auto-rows-fr makes the
          rows share the card's stretched height (this card matches the taller
          Quick-actions card via lg:items-stretch), so a handful of folders read
          as substantial cards instead of short pills floated at the top.
          min-h keeps a floor for the many-folders case. */}
      <div className="mt-4 grid flex-1 auto-rows-fr grid-cols-2 gap-compact lg:grid-cols-3">
        {visible.map((folder) => (
          <div
            key={folder.id || folder.name}
            className="flex min-h-[2.75rem] items-center gap-compact rounded-xl border border-border-soft/50 bg-system-gray-100/40 px-3 py-2 text-sm font-medium"
            title={folder.name}
          >
            <FolderTree className="h-4 w-4 shrink-0 text-stratosort-warning" aria-hidden="true" />
            <span className="truncate">{folder.name}</span>
          </div>
        ))}
        {overflow > 0 ? (
          <div className="flex min-h-[2.75rem] items-center justify-center rounded-xl border border-dashed border-border-soft/50 px-3 py-2 text-sm text-system-gray-600">
            {`+${overflow} more`}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

SmartFoldersCard.propTypes = {
  folders: PropTypes.arrayOf(PropTypes.object).isRequired,
  onManage: PropTypes.func.isRequired,
  className: PropTypes.string
};

function QuickActionTile({ icon: Icon, title, description, onClick, tone }) {
  return (
    <Card
      as="button"
      type="button"
      variant="interactive"
      onClick={onClick}
      className="group/tile interactive-lift text-left w-full h-full focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <div className="flex items-start gap-cozy">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-150 ease-out group-hover/tile:scale-105 ${
            ACTION_TONE[tone] || ACTION_TONE.blue
          }`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <Text as="span" variant="small" className="block font-semibold text-system-gray-900">
            {title}
          </Text>
          <Text as="span" variant="tiny" className="block">
            {description}
          </Text>
        </span>
        <ArrowRight
          className="ml-auto mt-1 h-4 w-4 shrink-0 text-system-gray-400 transition-transform duration-150 ease-out group-hover/tile:translate-x-1 group-hover/tile:text-stratosort-blue"
          aria-hidden="true"
        />
      </div>
    </Card>
  );
}

QuickActionTile.propTypes = {
  icon: PropTypes.elementType.isRequired,
  title: PropTypes.string.isRequired,
  description: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  tone: PropTypes.oneOf(['blue', 'green', 'amber'])
};

/**
 * ActivityCard — the side-rail history. When nothing is organized yet but files
 * are moving through the pipeline, it previews the in-flight queue so the rail
 * stays informative instead of reading as dead space.
 */
function ActivityCard({
  recent,
  queue,
  redactPaths,
  onViewAll,
  onAddFiles,
  onViewQueue,
  className
}) {
  const hasRecent = recent.length > 0;
  const hasQueue = queue.length > 0;

  return (
    <Card variant="default" className={className}>
      <SectionLabel>Recent activity</SectionLabel>
      {!hasRecent && !hasQueue ? (
        <div className="lg:flex lg:flex-1 lg:flex-col lg:justify-center">
          <StateMessage
            align="left"
            size="sm"
            tone="info"
            icon={FolderTree}
            title="No activity yet"
            description="Organized files will show up here as you confirm suggestions."
            className="mt-4 lg:mt-0"
            action={
              <Button variant="subtle" size="sm" onClick={onAddFiles}>
                Add files to start
              </Button>
            }
          />
        </div>
      ) : !hasRecent && hasQueue ? (
        <>
          <Text variant="tiny" className="mt-3 block text-system-gray-600">
            Files moving through your pipeline right now.
          </Text>
          <Stack gap="compact" className="mt-3">
            {queue.map((file, idx) => {
              const StatusIcon = file.status === 'ready' ? FolderInput : Sparkles;
              const statusLabel = file.status === 'ready' ? 'Ready' : 'Awaiting';
              const statusClass =
                file.status === 'ready' ? 'text-stratosort-blue' : 'text-stratosort-warning';
              return (
                <div
                  key={`${file.path || file.name || 'file'}-${idx}`}
                  className="flex items-center gap-compact"
                >
                  <StatusIcon className={`h-4 w-4 shrink-0 ${statusClass}`} aria-hidden="true" />
                  <Text variant="small" className="min-w-0 truncate">
                    {formatDisplayFileName(file.displayName, { redact: redactPaths })}
                  </Text>
                  <Caption className={`ml-auto shrink-0 ${statusClass}`}>{statusLabel}</Caption>
                </div>
              );
            })}
          </Stack>
          <div className="mt-4 lg:mt-auto lg:pt-4">
            <Button variant="ghost" size="sm" onClick={onViewQueue}>
              {queue.some((file) => file.status === 'ready')
                ? 'Review ready files'
                : 'View in Discover'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Stack gap="compact" className="mt-4">
            {recent.map((file, idx) => (
              <div
                key={`${file.originalPath || file.newName || 'file'}-${idx}`}
                className="flex items-center gap-compact"
              >
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-stratosort-success"
                  aria-hidden="true"
                />
                <Text variant="small" className="truncate">
                  {formatDisplayFileName(file.newName || file.originalName || 'Unknown', {
                    redact: redactPaths
                  })}
                </Text>
              </div>
            ))}
          </Stack>
          <div className="mt-4 lg:mt-auto lg:pt-4">
            <Button variant="ghost" size="sm" onClick={onViewAll}>
              View all results
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

ActivityCard.propTypes = {
  recent: PropTypes.arrayOf(PropTypes.object).isRequired,
  queue: PropTypes.arrayOf(PropTypes.object).isRequired,
  redactPaths: PropTypes.bool,
  onViewAll: PropTypes.func.isRequired,
  onAddFiles: PropTypes.func.isRequired,
  onViewQueue: PropTypes.func.isRequired,
  className: PropTypes.string
};

/**
 * DashboardView — the wide, scannable, single-screen alternative to the guided
 * phased flow. It composes existing summary/progress primitives and deep-links
 * into the phases for the actual work (Discover owns the file pickers, Setup owns
 * smart-folder management). It is deliberately NOT a phase (not in PHASE_ORDER);
 * App.js branches to it based on `ui.viewMode`.
 */
export default function DashboardView() {
  const dispatch = useAppDispatch();
  const currentPhase = useAppSelector((s) => s.ui.currentPhase);
  const stats = useAppSelector(selectFileStats);
  const smartFolders = useAppSelector(selectSmartFolders);
  const organizedFiles = useAppSelector(selectOrganizedFiles);
  const organizedCount = useAppSelector(selectOrganizedCount);
  const filesWithAnalysis = useAppSelector(selectFilesWithAnalysis);
  const isAnalyzing = useAppSelector(selectIsAnalyzing);
  const progress = useAppSelector(selectAnalysisProgress);
  const redactPaths = useAppSelector(selectRedactPaths);

  // Leaving the dashboard hands the user back to the phased flow at a chosen
  // step. setPhase enforces PHASE_TRANSITIONS, and not every phase is directly
  // reachable from the current one — but `discover` is reachable from every
  // phase and can in turn reach setup/organize/welcome, so it serves as a
  // universal hub for the one illegal-transition case.
  const goToPhase = useCallback(
    (target) => {
      dispatch(setViewMode('phased'));
      // Leave a breadcrumb so the phased chrome can offer a one-click way home.
      // setViewMode clears the flag, so this must follow it.
      dispatch(setCameFromDashboard(true));
      if (currentPhase === target) return;
      if (canTransitionTo(currentPhase, target)) {
        dispatch(setPhase(target));
      } else {
        dispatch(setPhase('discover'));
        if (target !== 'discover') dispatch(setPhase(target));
      }
    },
    [dispatch, currentPhase]
  );

  const goOrganize = useCallback(() => goToPhase('organize'), [goToPhase]);
  const goDiscover = useCallback(() => goToPhase('discover'), [goToPhase]);
  const goSetup = useCallback(() => goToPhase('setup'), [goToPhase]);

  // Navigate to discover, then bridge a window event to its picker/drop handlers
  // once it has mounted (see PICKER_BRIDGE_DELAY). One live retry loop per
  // event, cancelled on unmount: rapid double triggers otherwise left two
  // loops that BOTH got acked once DiscoverPhase mounted (double file
  // dialog), and an orphaned loop could fire a surprise picker later.
  const pendingBridgeDispatchesRef = useRef(/** @type {Map<string, () => void>} */ (new Map()));
  const bridgeDispatch = useCallback((eventName, detail) => {
    const pending = pendingBridgeDispatchesRef.current;
    pending.get(eventName)?.();
    pending.set(eventName, dispatchAcked(eventName, { detail, intervalMs: PICKER_BRIDGE_DELAY }));
  }, []);
  useEffect(() => {
    const pending = pendingBridgeDispatchesRef.current;
    return () => {
      for (const cancel of pending.values()) cancel();
      pending.clear();
    };
  }, []);

  const requestPicker = useCallback(
    (eventName) => {
      goToPhase('discover');
      bridgeDispatch(eventName);
    },
    [goToPhase, bridgeDispatch]
  );
  const openFilePicker = useCallback(() => requestPicker('app:select-files'), [requestPicker]);
  const openFolderPicker = useCallback(() => requestPicker('app:select-folder'), [requestPicker]);

  const handleDashboardDrop = useCallback(
    (files) => {
      if (!Array.isArray(files) || files.length === 0) return;
      goToPhase('discover');
      bridgeDispatch('app:drop-files', files);
    },
    [goToPhase, bridgeDispatch]
  );
  const { isDragging, dragProps } = useDragAndDrop(handleDashboardDrop);

  const recent = useMemo(() => organizedFiles.slice(-RECENT_LIMIT).reverse(), [organizedFiles]);

  const queuePreview = useMemo(() => {
    if (!Array.isArray(filesWithAnalysis) || filesWithAnalysis.length === 0) return [];
    return filesWithAnalysis
      .filter((file) => !file.error)
      .slice(-QUEUE_PREVIEW_LIMIT)
      .reverse()
      .map((file) => ({
        path: file.path,
        displayName: file.name || file.path || 'Unknown',
        status: file.analysis ? 'ready' : 'pending'
      }));
  }, [filesWithAnalysis]);

  const handleViewQueue = useCallback(() => {
    if (queuePreview.some((file) => file.status === 'ready')) {
      goOrganize();
      return;
    }
    goDiscover();
  }, [goDiscover, goOrganize, queuePreview]);

  // Adaptive status pill — collapse the whole pipeline state into one reassuring
  // (or actionable) phrase. Failures dominate, then pending work, then ready
  // work, otherwise the calm "all caught up" success state.
  const status = useMemo(() => {
    if (stats.failed > 0) {
      return { label: `${stats.failed} need attention`, variant: 'error', icon: AlertTriangle };
    }
    if (stats.pending > 0) {
      return { label: `${stats.pending} awaiting analysis`, variant: 'info', icon: Sparkles };
    }
    if (stats.ready > 0) {
      return { label: `${stats.ready} ready to organize`, variant: 'info', icon: ArrowRight };
    }
    return { label: 'All caught up', variant: 'success', icon: CheckCircle2 };
  }, [stats.failed, stats.pending, stats.ready]);

  const summary = useMemo(() => {
    const folderCount = smartFolders.length;
    const folderNoun = folderCount === 1 ? 'smart folder' : 'smart folders';
    const inFlight = stats.pending + stats.ready;

    if (inFlight === 0 && organizedCount === 0) {
      return `${folderCount} ${folderNoun} ready · add files to get started`;
    }
    if (inFlight === 0) {
      return `${folderCount} ${folderNoun} ready · all files organized`;
    }

    const parts = [];
    if (stats.pending > 0) {
      parts.push(`${stats.pending} awaiting analysis`);
    }
    if (stats.ready > 0) {
      parts.push(`${stats.ready} ready to organize`);
    }
    return `${folderCount} ${folderNoun} ready · ${parts.join(', ')}`;
  }, [smartFolders.length, stats.pending, stats.ready, organizedCount]);

  const reduceMotion = useReducedMotion();
  const blockVariants = reduceMotion ? BLOCK_VARIANTS_REDUCED : BLOCK_VARIANTS;

  // The drag surface + drop-target ring stay on this plain root so the
  // drag-and-drop wiring is never coupled to an animating node. The staggered
  // entrance lives on the motion container inside it.
  return (
    <div
      {...dragProps}
      className={`relative flex w-full flex-col rounded-2xl transition-shadow ${
        isDragging ? 'ring-2 ring-stratosort-blue/40 ring-offset-2' : ''
      }`}
    >
      {/* Ambient atmosphere behind the whole board so it floats on a soft brand
          glow instead of flat surface-gray. aria-hidden, non-interactive, clipped
          to the rounded shell; sits at z-0 with content lifted to z-10. The faint
          blobs read mainly through the gutters between the translucent cards. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-2xl"
      >
        <div
          className="absolute -right-16 -top-24 h-72 w-72 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(59, 160, 192, 0.10), transparent 70%)'
          }}
        />
        <div
          className="absolute -bottom-24 -left-12 h-64 w-64 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(224, 160, 32, 0.06), transparent 70%)'
          }}
        />
      </div>
      <motion.div
        variants={STAGGER_VARIANTS}
        initial="hidden"
        animate="show"
        className="relative z-10 flex flex-col gap-default"
      >
        <motion.div variants={blockVariants}>
          <HeroBand
            status={status}
            greeting="Welcome back"
            summary={summary}
            onImport={openFolderPicker}
            onAdd={openFilePicker}
          />
        </motion.div>

        <motion.div variants={blockVariants} className="flex flex-col gap-default">
          {isAnalyzing && progress && <AnalysisProgress progress={progress} />}

          {/* Live-status zone — the two surfaces that answer "what's happening?".
              The pipeline holds the aggregate counts; the activity rail holds the
              individual items behind those counts, so they are paired and share a
              height via items-stretch rather than living in separate columns. */}
          <div className="grid grid-cols-1 gap-default lg:grid-cols-[2fr_1fr] lg:items-stretch">
            <PipelineCard
              stats={stats}
              organizedCount={organizedCount}
              onReviewFailed={goOrganize}
              onPendingStage={stats.pending > 0 ? goDiscover : undefined}
              onReadyStage={stats.ready > 0 ? goOrganize : undefined}
              onOrganizedStage={organizedCount > 0 ? goOrganize : undefined}
              className="lg:flex lg:flex-col"
            />
            <ActivityCard
              recent={recent}
              queue={queuePreview}
              redactPaths={redactPaths}
              onViewAll={goOrganize}
              onAddFiles={openFilePicker}
              onViewQueue={handleViewQueue}
              className="lg:flex lg:flex-col"
            />
          </div>

          {/* Sits directly under the status zone it refers to, so the problem and
              the counts that flagged it read as one thought. */}
          {stats.failed > 0 && (
            <AlertBox variant="danger">
              {stats.failed} {stats.failed === 1 ? 'file' : 'files'} couldn&apos;t be analyzed —
              review {stats.failed === 1 ? 'it' : 'them'} in Organize.
            </AlertBox>
          )}

          {/* Get-things-done zone — shortcuts to the working surfaces paired with
              the smart-folder destinations they feed. Same 2fr/1fr split as the
              status row above so the column gutter lines up down the page. */}
          <div className="grid grid-cols-1 gap-default lg:grid-cols-[2fr_1fr] lg:items-stretch">
            <Card variant="default" className="h-full lg:flex lg:flex-col">
              <SectionLabel>Quick actions</SectionLabel>
              <div className="mt-4 grid grid-cols-1 gap-cozy sm:grid-cols-3 sm:items-stretch lg:flex-1">
                <QuickActionTile
                  icon={FolderPlus}
                  title="Add & analyze files"
                  description="Pick files and let the AI read them"
                  onClick={openFilePicker}
                  tone="blue"
                />
                <QuickActionTile
                  icon={Sparkles}
                  title="Review & organize"
                  description="Confirm suggestions and move files"
                  onClick={goOrganize}
                  tone="green"
                />
                <QuickActionTile
                  icon={FolderTree}
                  title="Manage smart folders"
                  description="Edit your organization destinations"
                  onClick={goSetup}
                  tone="amber"
                />
              </div>
            </Card>

            <SmartFoldersCard
              folders={smartFolders}
              onManage={goSetup}
              className="h-full lg:flex lg:flex-col"
            />
          </div>

          {/* Knowledge layer — a pride-surface summary of every file the local
              AI has processed. Sits at the foot of the board so it reads as a
              reward / closing thought after the pipeline and quick-action rows. */}
          <KnowledgeStatsCard />
        </motion.div>
      </motion.div>
    </div>
  );
}
