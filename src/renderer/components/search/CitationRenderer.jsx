import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '../ui';
import IconButton from '../ui/IconButton';
import CitationPreview from './CitationPreview';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('CitationRenderer');

/** Pre-compiled regex — avoids re-creating on every render. */
const CITATION_SPLIT_RE = /(\[doc-\d+\])/g;
const CITATION_MATCH_RE = /^\[(doc-\d+)\]$/;

/** Clamp the preview position so it stays within the visible viewport. */
function clampPreviewPosition(rect) {
  const PREVIEW_W = 320; // matches CitationPreview w-80
  const PREVIEW_H_EST = 280; // estimated max height of preview card
  const MARGIN = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.left;
  if (left + PREVIEW_W > vw - MARGIN) {
    left = Math.max(MARGIN, vw - PREVIEW_W - MARGIN);
  }
  if (left < MARGIN) left = MARGIN;

  // Prefer showing above the citation; fall back to below if not enough room
  let top = rect.top - 10;
  let flipBelow = false;
  if (top - PREVIEW_H_EST < MARGIN) {
    top = rect.bottom + 10;
    flipBelow = true;
  }
  // If below would also overflow, clamp to bottom
  if (flipBelow && top + PREVIEW_H_EST > vh - MARGIN) {
    top = vh - PREVIEW_H_EST - MARGIN;
  }

  return { top, left, flipBelow };
}

export default function CitationRenderer({ text, sources, onOpenSource }) {
  const [hoveredCitation, setHoveredCitation] = useState(null);
  const [previewPos, setPreviewPos] = useState({ top: 0, left: 0, flipBelow: false });
  const timeoutRef = useRef(null);
  const reduceMotion = useReducedMotion();

  const sourceById = useMemo(() => new Map((sources || []).map((s) => [s.id, s])), [sources]);

  const showPreviewFor = useCallback((target, docId) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const rect = target.getBoundingClientRect();
    setPreviewPos(clampPreviewPosition(rect));
    setHoveredCitation(docId);
  }, []);

  const handleMouseEnter = useCallback(
    (e, docId) => showPreviewFor(e.currentTarget, docId),
    [showPreviewFor]
  );

  const handleFocus = useCallback(
    (e, docId) => showPreviewFor(e.currentTarget, docId),
    [showPreviewFor]
  );

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      setHoveredCitation(null);
    }, 300);
  }, []);

  const cancelDismiss = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const dismissPreview = useCallback(() => setHoveredCitation(null), []);

  // Cleanup timeout
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Escape closes the hover/focus preview without removing focus from the
  // citation token. Listener is global because the preview is portaled to
  // the body and may not be in the citation's DOM ancestry.
  useEffect(() => {
    if (!hoveredCitation) return undefined;
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismissPreview();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hoveredCitation, dismissPreview]);

  if (!text) return null;

  const parts = text.split(CITATION_SPLIT_RE);

  return (
    <>
      <span>
        {parts.map((part, i) => {
          const match = part.match(CITATION_MATCH_RE);
          if (match) {
            const docId = match[1];
            const source = sourceById.get(docId);

            if (!source) {
              logger.warn('Citation token has no matching source (skipped or hallucinated)', {
                docId
              });
              return (
                <span
                  key={i}
                  className="align-super font-mono text-xs text-system-gray-500 mx-0.5"
                  title="Source not in retrieval list for this turn"
                >
                  [?]
                </span>
              );
            }

            const docNum = docId.replace('doc-', '');

            return (
              <Button
                key={i}
                variant="ghost"
                size="xs"
                className="align-super font-bold text-stratosort-blue bg-stratosort-blue/10 hover:bg-stratosort-blue hover:text-white rounded-md px-1 min-w-[16px] h-4 mx-0.5 select-none focus-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSource?.(source);
                }}
                onMouseEnter={(e) => handleMouseEnter(e, docId)}
                onMouseLeave={handleMouseLeave}
                onFocus={(e) => handleFocus(e, docId)}
                onBlur={handleMouseLeave}
                aria-label={`Citation ${docNum}: ${source.name || 'document'}. Press Enter to open, Escape to close preview.`}
              >
                {docNum}
              </Button>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </span>

      {createPortal(
        <AnimatePresence>
          {hoveredCitation && sourceById.get(hoveredCitation) ? (
            <motion.div
              key={hoveredCitation}
              className="fixed z-50"
              style={{
                top: previewPos.top,
                left: previewPos.left,
                transform: previewPos.flipBelow ? 'none' : 'translateY(-100%)'
              }}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
              transition={{ duration: reduceMotion ? 0.08 : 0.14, ease: [0.22, 1, 0.36, 1] }}
              onMouseEnter={cancelDismiss}
              onMouseLeave={dismissPreview}
              role="dialog"
              aria-label={`Citation preview: ${sourceById.get(hoveredCitation).name || 'document'}`}
            >
              <div className="relative">
                <CitationPreview source={sourceById.get(hoveredCitation)} onOpen={onOpenSource} />
                <IconButton
                  icon={<X className="w-3 h-3" />}
                  size="sm"
                  variant="ghost"
                  onClick={dismissPreview}
                  className="absolute top-1 right-1 h-6 w-6 text-system-gray-400 hover:text-system-gray-700 bg-system-gray-100/80 hover:bg-system-gray-100"
                  aria-label="Close citation preview"
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

CitationRenderer.propTypes = {
  text: PropTypes.string,
  sources: PropTypes.array,
  onOpenSource: PropTypes.func.isRequired
};
