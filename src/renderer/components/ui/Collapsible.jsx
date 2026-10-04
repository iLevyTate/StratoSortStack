import React, { useEffect, useId, useState, useCallback, useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import { ChevronRight } from 'lucide-react';
import { Heading, Text } from './Typography';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('Collapsible');
const Collapsible = memo(function Collapsible({
  title,
  children,
  actions = null,
  defaultOpen = true,
  className = '',
  contentClassName = '',
  persistKey,
  collapsedPreview = null
}) {
  const contentId = useId();
  const titleId = useId();
  const storageKey = persistKey ? `collapsible:${persistKey}` : null;
  const initialOpen = useMemo(() => {
    if (storageKey && typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved === 'true' || saved === 'false') return saved === 'true';
      } catch (error) {
        logger.error('Failed to load collapsible state', {
          error: error.message
        });
      }
    }
    return Boolean(defaultOpen);
  }, [storageKey, defaultOpen]);

  const [isOpen, setIsOpen] = useState(initialOpen);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      if (storageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, String(next));
        } catch (error) {
          logger.error('Failed to persist collapsible state', {
            error: error.message
          });
        }
      }
      return next;
    });
  }, [storageKey]);

  // React to external expand/collapse broadcasts via storage events
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return undefined;
    const onStorage = (e) => {
      // If key provided and doesn't match ours, ignore. If generic event, still check our key.
      if (e && e.key && e.key !== storageKey) return;
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved === 'true' || saved === 'false') {
          setIsOpen(saved === 'true');
        }
      } catch (error) {
        logger.error('Failed to sync collapsible state', {
          error: error.message
        });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  // Prefer explicit styling from callers; fall back to a lightweight card surface.
  // Settings renders many sections; avoid nested heavy blur/padding for better proportions.
  const baseSectionClass = className && className.trim().length > 0 ? className.trim() : 'list-row';
  const sectionClasses = `${baseSectionClass} space-y-3`.trim();
  // Header padding: slightly tighter than a full panel
  const headerPadding = 'px-[var(--panel-padding)] pt-[calc(var(--panel-padding)*0.65)]';
  // Content padding: use contentClassName if provided, otherwise add default padding
  // Check for any padding class (p-, px-, py-, pt-, pb-, pl-, pr-)
  const hasPadding =
    contentClassName && /(p[xytblr]?-(\d+|\[.+\])|p-(\d+|\[.+\]))/.test(contentClassName);
  const defaultContentPadding = hasPadding
    ? ''
    : 'px-[var(--panel-padding)] pb-[calc(var(--panel-padding)*0.75)]';

  const titleLabel =
    typeof title === 'string' || typeof title === 'number' ? String(title) : 'Section';

  return (
    <section className={`${sectionClasses} flex flex-col flex-shrink-0`}>
      <div
        className={`flex items-center justify-between gap-default ${headerPadding} flex-shrink-0`}
      >
        <button
          type="button"
          onClick={toggle}
          className="text-left min-w-0 flex-1 mr-2 rounded-md px-1 py-0.5 -mx-1 hover:bg-system-gray-100/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} section: ${titleLabel}`}
        >
          <Heading as="h3" variant="h6" id={titleId} className="m-0 leading-tight">
            {title}
          </Heading>
        </button>
        <Text
          as="div"
          variant="tiny"
          className="flex items-center gap-cozy text-system-gray-500 shrink-0"
        >
          <button
            type="button"
            className="p-1.5 rounded-md border border-border-soft bg-system-gray-100/80 hover:bg-system-gray-100 hover:border-system-gray-300 text-system-gray-600 hover:text-system-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2 flex items-center justify-center"
            style={{
              transitionProperty: 'background-color, border-color, color, box-shadow',
              transitionDuration: 'var(--motion-duration-fast)',
              transitionTimingFunction: 'var(--motion-ease-standard)'
            }}
            onClick={toggle}
            aria-expanded={isOpen}
            aria-controls={contentId}
            aria-label={isOpen ? 'Collapse section' : 'Expand section'}
            title={isOpen ? 'Collapse section' : 'Expand section'}
          >
            <ChevronRight
              className="w-4 h-4"
              style={{
                transitionProperty: 'transform',
                transitionDuration: 'var(--motion-duration-standard)',
                transitionTimingFunction: 'var(--motion-ease-emphasized)',
                transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)'
              }}
            />
          </button>
          {actions ? <div className="flex items-center gap-cozy">{actions}</div> : null}
        </Text>
      </div>

      {isOpen ? (
        <div
          id={contentId}
          role="region"
          aria-labelledby={titleId}
          className={`mt-3 ${contentClassName || defaultContentPadding}`.trim()}
        >
          {children}
        </div>
      ) : (
        <Text
          as="div"
          variant="small"
          id={contentId}
          className="mt-3 px-[var(--panel-padding)] pb-[calc(var(--panel-padding)*0.5)] text-system-gray-500"
        >
          {collapsedPreview || (
            <button
              type="button"
              onClick={toggle}
              className="flex w-full items-center gap-compact py-2 border-t border-border-soft/50 text-left rounded-md hover:text-system-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2"
            >
              <ChevronRight className="w-3 h-3 text-system-gray-500" />
              <span className="italic text-system-gray-600">
                Expand this section to view or edit settings.
              </span>
            </button>
          )}
        </Text>
      )}
    </section>
  );
});

Collapsible.propTypes = {
  title: PropTypes.node.isRequired,
  children: PropTypes.node.isRequired,
  actions: PropTypes.node,
  defaultOpen: PropTypes.bool,
  className: PropTypes.string,
  contentClassName: PropTypes.string,
  persistKey: PropTypes.string,
  collapsedPreview: PropTypes.node
};

export default Collapsible;
