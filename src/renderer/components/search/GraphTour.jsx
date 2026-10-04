import React, { useState, useEffect, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { useDispatch, useSelector } from 'react-redux';
import {
  X,
  ChevronRight,
  ChevronLeft,
  Search,
  Layers,
  Map,
  GitBranch,
  EyeOff,
  Orbit
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import { Heading, Text } from '../ui/Typography';
import { useDialogFocusTrap } from '../../hooks';
import { setGraphTourDismissed } from '../../store/slices/uiSlice';

const TOUR_STORAGE_KEY = 'graphTourDismissed';

/**
 * Tour steps for the graph visualization
 */
const TOUR_STEPS = [
  {
    id: 'search',
    icon: Search,
    title: 'Search for files',
    content:
      'Type a query to find files and add them to the graph. Use natural language like "tax documents" or "project notes".',
    position: 'center'
  },
  {
    id: 'clusters',
    icon: Layers,
    title: 'Explore clusters',
    content:
      'Click "Auto-discover clusters" to see how your files group by topic (or switch to time, type, or tag in Explore). AI names each cluster; border color shows naming confidence. Double-click a cluster to reveal its files.',
    position: 'center'
  },
  {
    id: 'bridges',
    icon: GitBranch,
    title: 'Topic bridges',
    content:
      'Dashed lines between clusters mean your topics overlap. When the label shows a number, that many files sit in both groups — useful for shared clients, projects, or duplicates across folders. Hover or click the label for details.',
    position: 'center'
  },
  {
    id: 'navigate',
    icon: Map,
    title: 'Navigate the graph',
    content:
      'Use the minimap in the corner to navigate large graphs. Drag the canvas to pan, use the +/- zoom controls, and click nodes to see details in the right panel. Use Arrow keys to move between nodes and Space to expand or collapse a selected cluster.',
    position: 'center'
  },
  {
    id: 'atlas',
    icon: Orbit,
    title: 'The Atlas, a companion view',
    content:
      'Alongside Relate there is the Atlas — a zoomable map of every file where nearby dots are similar. Reach for the Atlas when you want the whole library at a glance or to lasso-select for bulk moves; come back to Relate to follow the links between specific files.',
    position: 'center'
  }
];

/**
 * GraphTour - A simple tooltip tour for first-time graph users
 *
 * Shows a series of helpful tips when the user first opens the graph tab.
 * Dismissal is persisted via Redux (and localStorage for migration) so it won't show again.
 */
const GraphTour = ({ isOpen, onComplete = null, forceShow = false }) => {
  const dispatch = useDispatch();
  const graphTourDismissed = useSelector((state) => state.ui.graphTourDismissed);
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(true); // Default checked

  const persistDismissal = useCallback(() => {
    dispatch(setGraphTourDismissed(true));
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, 'true');
    } catch {
      // localStorage not available
    }
  }, [dispatch]);

  const clearDismissal = useCallback(() => {
    dispatch(setGraphTourDismissed(false));
    try {
      localStorage.removeItem(TOUR_STORAGE_KEY);
    } catch {
      // localStorage not available
    }
  }, [dispatch]);

  // Check if user has already dismissed the tour (or force show via help button)
  useEffect(() => {
    if (!isOpen) {
      setIsVisible(false);
      setDontShowAgain(true);
      return;
    }

    setCurrentStep(0);

    // If forceShow is true, always show immediately
    if (forceShow) {
      setIsVisible(true);
      return;
    }

    // Check Redux first, then legacy localStorage
    const isDismissed =
      graphTourDismissed ||
      (typeof localStorage !== 'undefined' && localStorage.getItem(TOUR_STORAGE_KEY) === 'true');
    if (!isDismissed) {
      const timer = setTimeout(() => setIsVisible(true), 500);
      return () => clearTimeout(timer);
    }
  }, [isOpen, forceShow, graphTourDismissed]);

  const handleDismiss = useCallback(
    (rememberChoice = true) => {
      if (rememberChoice) {
        persistDismissal();
      } else if (forceShow) {
        clearDismissal();
      }
      setIsVisible(false);
      onComplete?.();
    },
    [persistDismissal, clearDismissal, forceShow, onComplete]
  );

  const handleNext = useCallback(() => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep((prev) => prev + 1);
    } else {
      // Complete tour - respect the current checkbox preference
      handleDismiss(dontShowAgain);
    }
  }, [currentStep, handleDismiss, dontShowAgain]);

  const handlePrev = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep]);

  const handleClose = useCallback(() => {
    handleDismiss(dontShowAgain);
  }, [dontShowAgain, handleDismiss]);

  const dialogRef = useRef(null);
  useDialogFocusTrap({ active: isVisible, containerRef: dialogRef, onEscape: handleClose });

  if (!isVisible) return null;

  const step = TOUR_STEPS[currentStep];
  const StepIcon = step.icon;
  const isLastStep = currentStep === TOUR_STEPS.length - 1;
  const isFirstStep = currentStep === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ backgroundColor: 'var(--overlay-scrim-subtle)' }}
      onClick={handleClose}
      role="presentation"
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- click-outside scrim; Escape handled by useDialogFocusTrap */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-tour-title"
        tabIndex={-1}
        className="mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border-soft bg-system-gray-100 shadow-2xl animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-gradient-primary-start to-gradient-primary-end px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-cozy">
            <div className="w-10 h-10 rounded-full bg-system-gray-100/20 flex items-center justify-center">
              <StepIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <Heading as="h3" variant="h6" className="text-white" id="graph-tour-title">
                {step.title}
              </Heading>
              <Text as="p" variant="tiny" className="text-system-gray-100/80">
                Step {currentStep + 1} of {TOUR_STEPS.length}
              </Text>
            </div>
          </div>
          <IconButton
            onClick={handleClose}
            icon={<X className="w-5 h-5" />}
            size="sm"
            variant="ghost"
            className="h-8 w-8 text-system-gray-100/80 hover:text-white hover:bg-system-gray-100/20"
            title="Close tour"
            aria-label="Close tour"
          />
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          <Text variant="small" className="text-system-gray-600 leading-relaxed">
            {step.content}
          </Text>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-compact pb-4">
          {TOUR_STEPS.map((_, idx) => (
            <Button
              key={idx}
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setCurrentStep(idx)}
              className={`w-2 h-2 min-w-0 p-0 rounded-full transition-[width,background-color] ${
                idx === currentStep
                  ? 'bg-stratosort-blue w-6'
                  : 'bg-system-gray-300 hover:bg-system-gray-400'
              }`}
              aria-label={`Go to step ${idx + 1}`}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-system-gray-200 px-6 py-4 bg-system-gray-50/50">
          {/* Don't show again checkbox */}
          <div className="flex items-center gap-compact mb-3">
            <Text
              as="label"
              variant="small"
              className="flex items-center gap-compact text-system-gray-600 cursor-pointer select-none"
            >
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue"
              />
              <EyeOff className="w-3.5 h-3.5" />
              <span>Don&apos;t show this again</span>
            </Text>
          </div>

          {/* Navigation buttons */}
          <div className="flex justify-between items-center">
            <Button
              onClick={handleClose}
              variant="ghost"
              size="sm"
              className="text-system-gray-500 hover:text-system-gray-700"
            >
              Close
            </Button>
            <div className="flex gap-compact">
              {!isFirstStep && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePrev}
                  className="text-system-gray-600"
                  aria-label="Back"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Back</span>
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={handleNext}>
                {isLastStep ? (
                  'Get started'
                ) : (
                  <>
                    <span>Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

GraphTour.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onComplete: PropTypes.func,
  forceShow: PropTypes.bool
};

export default GraphTour;
