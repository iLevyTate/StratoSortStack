import React, { Suspense, lazy } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useAppSelector } from '../store/hooks';
import PhaseErrorBoundary from './PhaseErrorBoundary';
import { LazyLoadingSpinner } from './ui/LoadingSkeleton';
import { logger } from '../../shared/logger';
import { PHASES, PHASE_METADATA } from '../../shared/constants';
import perfMarks from '../../shared/perfMarks';

// The settings overlay and useKeyboardShortcuts are deliberately NOT here:
// they live in App.js so they stay active on the dashboard surface, which
// replaces this component entirely (see App.js for the full rationale).

const WelcomePhase = lazy(() => import('../phases/WelcomePhase'));
const SetupPhase = lazy(() => import('../phases/SetupPhase'));
const DiscoverPhase = lazy(() => import('../phases/DiscoverPhase'));
const OrganizePhase = lazy(() => import('../phases/OrganizePhase'));
const CompletePhase = lazy(() => import('../phases/CompletePhase'));

const PHASE_IMPORTERS = {
  [PHASES?.WELCOME ?? 'welcome']: () => import('../phases/WelcomePhase'),
  [PHASES?.SETUP ?? 'setup']: () => import('../phases/SetupPhase'),
  [PHASES?.DISCOVER ?? 'discover']: () => import('../phases/DiscoverPhase'),
  [PHASES?.ORGANIZE ?? 'organize']: () => import('../phases/OrganizePhase'),
  [PHASES?.COMPLETE ?? 'complete']: () => import('../phases/CompletePhase')
};

function getLikelyNextPhases(phase) {
  switch (phase) {
    case PHASES?.WELCOME ?? 'welcome':
      return [PHASES?.SETUP ?? 'setup'];
    case PHASES?.SETUP ?? 'setup':
      return [PHASES?.DISCOVER ?? 'discover'];
    case PHASES?.DISCOVER ?? 'discover':
      return [PHASES?.ORGANIZE ?? 'organize', PHASES?.COMPLETE ?? 'complete'];
    case PHASES?.ORGANIZE ?? 'organize':
      return [PHASES?.COMPLETE ?? 'complete', PHASES?.DISCOVER ?? 'discover'];
    case PHASES?.COMPLETE ?? 'complete':
      return [PHASES?.DISCOVER ?? 'discover'];
    default:
      return [PHASES?.WELCOME ?? 'welcome'];
  }
}

function preloadLikelyPhases(activePhase) {
  const phasesToPreload = new Set([activePhase, ...getLikelyNextPhases(activePhase)]);
  phasesToPreload.forEach((phase) => {
    const importer = PHASE_IMPORTERS[phase];
    if (typeof importer === 'function') {
      importer();
    }
  });
}

// Refined, premium-feel phase transitions (subtle opacity-only, no gimmicky motion).
//
// These are module-scope frozen constants (no per-render allocation). Previously
// `pageVariants(reducedMotion)` ran every PhaseRenderer render, allocating a
// fresh object identity for `variants`; framer-motion stores variants on the
// motion node and compares by reference, so a fresh object broke variant
// equality and caused extra work on every unrelated state change.
const PAGE_VARIANTS_STANDARD = Object.freeze({
  initial: { opacity: 0 },
  in: {
    opacity: 1,
    transition: {
      duration: 0.24,
      ease: [0.22, 1, 0.36, 1]
    }
  },
  out: {
    opacity: 1,
    transition: {
      duration: 0.06,
      ease: [0.4, 0, 1, 1]
    }
  }
});

const PAGE_VARIANTS_REDUCED = Object.freeze({
  initial: { opacity: 0 },
  in: {
    opacity: 1,
    transition: {
      duration: 0.08,
      ease: [0.22, 1, 0.36, 1]
    }
  },
  out: {
    opacity: 1,
    transition: {
      duration: 0.01,
      ease: [0.4, 0, 1, 1]
    }
  }
});

/**
 * Polite live region that announces the phase title whenever the user
 * transitions between phases. Visually hidden via .sr-only — exists so
 * screen-reader users get an audible cue that matches the visual phase
 * change. Skips the very first render so the app doesn't announce its own
 * boot.
 */
const PhaseEnterAnnouncement = React.memo(function PhaseEnterAnnouncement({ currentPhase }) {
  const isFirstRender = React.useRef(true);
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const meta = PHASE_METADATA?.[currentPhase];
    if (!meta) return;
    const totalSteps = Object.keys(PHASE_METADATA).length;
    const stepNumber = (meta.step ?? 0) + 1;
    setMessage(`Step ${stepNumber} of ${totalSteps}: ${meta.title}. ${meta.description}.`);
  }, [currentPhase]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
});

function getPhaseLoadingMessage(phase) {
  switch (phase) {
    case PHASES?.WELCOME ?? 'welcome':
      return 'Preparing your workspace...';
    case PHASES?.SETUP ?? 'setup':
      return 'Preparing destinations...';
    case PHASES?.DISCOVER ?? 'discover':
      return 'Preparing analysis...';
    case PHASES?.ORGANIZE ?? 'organize':
      return 'Preparing review...';
    case PHASES?.COMPLETE ?? 'complete':
      return 'Preparing results...';
    default:
      return 'Preparing your workspace...';
  }
}

function PhaseRenderer() {
  const currentPhase = useAppSelector((state) => state.ui.currentPhase);
  const shouldReduceMotion = useReducedMotion();

  // Preload only the active and likely-next phases to keep startup light.
  React.useEffect(() => {
    const normalizedPhase =
      typeof currentPhase === 'string' ? currentPhase : (PHASES?.WELCOME ?? 'welcome');
    const timer = setTimeout(() => {
      preloadLikelyPhases(normalizedPhase);
    }, 1200);
    return () => clearTimeout(timer);
  }, [currentPhase]);

  // Phase-change signal for deep-dive diagnostics only. `debug` was too
  // loud: it fired on every route transition and drowned out the
  // genuinely actionable renderer messages in support logs. Keep it at
  // `trace` so it's still available when a developer opts-in, but
  // invisible at the default log level that ships with users.
  //
  // Alongside the trace log we drop a User Timing mark so support /
  // performance traces can see exactly when a phase transition fired
  // without us having to log at `debug` by default. The measure from the
  // previous phase's mark gives us a free "time spent in <phase>"
  // distribution in DevTools flame charts.
  const prevPhaseRef = React.useRef(null);
  React.useEffect(() => {
    logger.trace('[PhaseRenderer] Rendering phase:', currentPhase);
    const safePhase = typeof currentPhase === 'string' ? currentPhase : 'unknown';
    const markName = `phase:render:${safePhase}`;
    perfMarks.mark(markName);
    const prev = prevPhaseRef.current;
    if (prev && prev !== safePhase) {
      perfMarks.measure(`phase:transition:${prev}->${safePhase}`, `phase:render:${prev}`, markName);
    }
    prevPhaseRef.current = safePhase;
  }, [currentPhase]);

  // Fixed: Wrap each phase with PhaseErrorBoundary for isolated error handling
  const renderCurrentPhase = () => {
    switch (currentPhase) {
      case PHASES?.WELCOME ?? 'welcome':
        return (
          <PhaseErrorBoundary phaseName="Welcome">
            <WelcomePhase />
          </PhaseErrorBoundary>
        );
      case PHASES?.SETUP ?? 'setup':
        return (
          <PhaseErrorBoundary phaseName="Setup">
            <SetupPhase />
          </PhaseErrorBoundary>
        );
      case PHASES?.DISCOVER ?? 'discover':
        return (
          <PhaseErrorBoundary phaseName="Discover">
            <DiscoverPhase />
          </PhaseErrorBoundary>
        );
      case PHASES?.ORGANIZE ?? 'organize':
        return (
          <PhaseErrorBoundary phaseName="Organize">
            <OrganizePhase />
          </PhaseErrorBoundary>
        );
      case PHASES?.COMPLETE ?? 'complete':
        return (
          <PhaseErrorBoundary phaseName="Complete">
            <CompletePhase />
          </PhaseErrorBoundary>
        );
      default:
        return (
          <PhaseErrorBoundary phaseName="Welcome">
            <WelcomePhase />
          </PhaseErrorBoundary>
        );
    }
  };

  return (
    <>
      <PhaseEnterAnnouncement currentPhase={currentPhase} />
      <div className="flex flex-col w-full h-full">
        <Suspense fallback={<LazyLoadingSpinner message={getPhaseLoadingMessage(currentPhase)} />}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentPhase}
              initial="initial"
              animate="in"
              exit="out"
              variants={shouldReduceMotion ? PAGE_VARIANTS_REDUCED : PAGE_VARIANTS_STANDARD}
              className="w-full flex-1 flex flex-col backface-hidden"
              style={{ willChange: 'opacity' }}
            >
              {renderCurrentPhase()}
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </div>
    </>
  );
}

export default PhaseRenderer;
