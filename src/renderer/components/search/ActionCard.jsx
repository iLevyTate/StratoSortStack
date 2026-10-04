import React from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button';
import { Text } from '../ui/Typography';

/**
 * Verb-card: one headline, optional description, and one primary action
 * button. The cornerstone of the round-2 graph sidebar — every insight
 * surface (scattered files, clusters, bridges, near-dupes, health) renders
 * as one of these so the user always sees a sentence + a button to press.
 *
 * Keeping the card local to the search feature (rather than a shared ui/
 * primitive) is deliberate: the surface area is small, the styling is
 * graph-specific, and we don't want a new primitive that other features
 * might cargo-cult before we know the pattern sticks.
 */
function ActionCard({
  icon: Icon,
  headline,
  description = null,
  verb = null,
  onClick = null,
  onHeadlineClick = null,
  secondary = null,
  tone = 'default'
}) {
  const toneClass =
    tone === 'warning'
      ? 'border-stratosort-accent/30 bg-stratosort-accent/5'
      : tone === 'success'
        ? 'border-stratosort-success/30 bg-stratosort-success/5'
        : 'border-border-soft bg-system-gray-50/70';
  return (
    <div className={`rounded-lg border ${toneClass} p-3 space-y-2`}>
      <div className="flex items-start gap-compact">
        {Icon && (
          <Icon className="w-4 h-4 shrink-0 text-stratosort-blue mt-0.5" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          {onHeadlineClick ? (
            // Clickable title: jumps to and selects the underlying node in the
            // graph. Rendered as a real button so it's keyboard-reachable.
            <button
              type="button"
              onClick={onHeadlineClick}
              title="Show in graph"
              className="block w-full text-left text-sm font-semibold leading-snug text-system-gray-800 rounded transition-colors hover:text-stratosort-blue hover:underline decoration-stratosort-blue/40 underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/40"
            >
              {headline}
            </button>
          ) : (
            <Text
              as="div"
              variant="small"
              className="font-semibold text-system-gray-800 leading-snug"
            >
              {headline}
            </Text>
          )}
          {description && (
            <Text as="div" variant="tiny" className="text-system-gray-500 mt-0.5">
              {description}
            </Text>
          )}
        </div>
      </div>
      {(verb || secondary) && (
        <div className="flex flex-col gap-1.5 pt-1">
          {verb && onClick && (
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onClick}
              className="w-full h-8 text-xs font-semibold"
            >
              {verb}
            </Button>
          )}
          {secondary && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={secondary.onClick}
              className="w-full h-8 text-xs"
            >
              {secondary.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

ActionCard.propTypes = {
  icon: PropTypes.elementType,
  headline: PropTypes.node.isRequired,
  description: PropTypes.node,
  verb: PropTypes.string,
  onClick: PropTypes.func,
  onHeadlineClick: PropTypes.func,
  secondary: PropTypes.shape({
    label: PropTypes.string.isRequired,
    onClick: PropTypes.func.isRequired
  }),
  tone: PropTypes.oneOf(['default', 'warning', 'success'])
};
ActionCard.displayName = 'ActionCard';

export default ActionCard;
