import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Card from './Card';
import IconButton from './IconButton';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('MinimizableGuideCard');

/**
 * Gradient-style guide card that can be minimized. Persists open/closed state in
 * localStorage under `collapsible:${persistKey}` (same convention as Collapsible.jsx)
 * so the preference survives phase changes and app restarts.
 *
 * `defaultOpen` defaults to `false` so guide cards start collapsed on first
 * visit — each phase already has its own header copy above the card, and
 * users asked that the explainer not occupy screen space by default. Once
 * a user expands the card, the preference is persisted and honored on
 * subsequent loads via `initialOpen`.
 */
const MinimizableGuideCard = memo(function MinimizableGuideCard({
  persistKey,
  defaultOpen = false,
  className = '',
  children,
  collapsedSummary,
  guideLabel = 'guide'
}) {
  const storageKey = persistKey ? `collapsible:${persistKey}` : null;

  const initialOpen = useMemo(() => {
    if (storageKey && typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved === 'true' || saved === 'false') return saved === 'true';
      } catch (error) {
        logger.error('Failed to load guide card state', { error: error.message });
      }
    }
    return Boolean(defaultOpen);
  }, [storageKey, defaultOpen]);

  const [isOpen, setIsOpen] = useState(initialOpen);

  const setOpen = useCallback(
    (next) => {
      setIsOpen(next);
      if (storageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, String(next));
        } catch (error) {
          logger.error('Failed to persist guide card state', { error: error.message });
        }
      }
    },
    [storageKey]
  );

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return undefined;
    const onStorage = (e) => {
      if (e && e.key && e.key !== storageKey) return;
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved === 'true' || saved === 'false') {
          setIsOpen(saved === 'true');
        }
      } catch (error) {
        logger.error('Failed to sync guide card state', { error: error.message });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  if (!isOpen) {
    return (
      <Card className={className}>
        <div className="flex items-center justify-between gap-cozy min-w-0">
          <div className="min-w-0 flex-1 text-left">{collapsedSummary}</div>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-label={`Expand ${guideLabel}`}
            title="Expand"
            icon={<ChevronDown className="w-4 h-4" />}
          />
        </div>
      </Card>
    );
  }

  return (
    <Card className={`relative ${className}`.trim()}>
      <div className="absolute top-3 right-3 sm:top-4 sm:right-4 z-[1]">
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          aria-expanded
          aria-label={`Minimize ${guideLabel}`}
          title="Minimize"
          icon={<ChevronUp className="w-4 h-4" />}
        />
      </div>
      <div className="pr-10 sm:pr-12">{children}</div>
    </Card>
  );
});

MinimizableGuideCard.propTypes = {
  persistKey: PropTypes.string.isRequired,
  defaultOpen: PropTypes.bool,
  className: PropTypes.string,
  children: PropTypes.node.isRequired,
  collapsedSummary: PropTypes.node.isRequired,
  guideLabel: PropTypes.string
};

export default MinimizableGuideCard;
