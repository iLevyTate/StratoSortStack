import React, { memo, useId } from 'react';
import PropTypes from 'prop-types';
import { EdgeLabelRenderer } from '@xyflow/react';

/**
 * Shared tooltip component for edges in the graph visualization.
 * Handles positioning, hover state, and common styling.
 *
 * A11y: the badge is rendered as a real `<button>` so keyboard users can
 * focus the edge affordance and toggle the details panel with Enter/Space.
 * `aria-expanded` mirrors the controlled `isHovered` state (which parents
 * should now drive from hover *or* focus/keyboard, not hover alone) and
 * `aria-controls` ties the button to the tooltip's id for assistive tech.
 */
const BaseEdgeTooltip = memo(
  ({
    isHovered,
    labelX,
    labelY,
    badgeText,
    badgeColorClass,
    title,
    headerColorClass = 'text-system-gray-900',
    onMouseEnter = null,
    onMouseLeave = null,
    onFocus = null,
    onBlur = null,
    onToggle = null,
    children = null
  }) => {
    const tooltipId = useId();
    const handleKeyDown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (typeof onToggle === 'function') {
        onToggle(!isHovered);
      } else if (isHovered) {
        onMouseLeave?.(event);
      } else {
        onMouseEnter?.(event);
      }
    };

    return (
      <EdgeLabelRenderer>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- hover-intent tracking only; not an action affordance */}
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            zIndex: isHovered ? 1000 : 1
          }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <button
            type="button"
            aria-expanded={isHovered}
            aria-controls={isHovered ? tooltipId : undefined}
            aria-label={`${title}: ${badgeText}`}
            onFocus={onFocus || onMouseEnter || undefined}
            onBlur={onBlur || onMouseLeave || undefined}
            onKeyDown={handleKeyDown}
            onClick={(event) => {
              if (typeof onToggle === 'function') {
                event.stopPropagation();
                onToggle(!isHovered);
              }
            }}
            className={`
              px-1.5 py-0.5 rounded-md text-xs font-medium cursor-pointer
              transition duration-200
              focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1
              focus-visible:ring-stratosort-accent
              ${badgeColorClass}
              ${isHovered ? 'shadow-lg scale-110' : ''}
            `}
          >
            {badgeText}
          </button>

          {isHovered && (
            <div
              id={tooltipId}
              role="tooltip"
              className="absolute left-1/2 -translate-x-1/2 mt-2 z-50"
              style={{ minWidth: '200px', maxWidth: '280px' }}
            >
              <div
                className="text-system-gray-700 text-xs rounded-xl shadow-xl border border-system-gray-200/80 p-3 space-y-2 animate-pop-in"
                style={{
                  background: 'color-mix(in srgb, var(--surface-raised) 96%, transparent)'
                }}
              >
                <div
                  className={`font-semibold border-b border-system-gray-100 pb-1.5 ${headerColorClass}`}
                >
                  {title}
                </div>

                {children}

                <div
                  className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 border-t border-l border-system-gray-200 rotate-45"
                  style={{ background: 'var(--surface-raised)' }}
                />
              </div>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    );
  }
);

BaseEdgeTooltip.displayName = 'BaseEdgeTooltip';

BaseEdgeTooltip.propTypes = {
  isHovered: PropTypes.bool.isRequired,
  labelX: PropTypes.number.isRequired,
  labelY: PropTypes.number.isRequired,
  badgeText: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  badgeColorClass: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  headerColorClass: PropTypes.string,
  onMouseEnter: PropTypes.func,
  onMouseLeave: PropTypes.func,
  onFocus: PropTypes.func,
  onBlur: PropTypes.func,
  onToggle: PropTypes.func,
  children: PropTypes.node
};

export default BaseEdgeTooltip;
