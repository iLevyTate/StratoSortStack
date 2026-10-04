import React from 'react';
import PropTypes from 'prop-types';

// Canonical loading ring: brand-blue circle with a transparent top arc (the
// LoadingSkeleton recipe). Sizes mirror the recipes that existed in the wild.
const SIZE_TO_CLASS = {
  xs: 'w-5 h-5 border-2',
  md: 'w-10 h-10 border-3',
  lg: 'w-12 h-12 border-4'
};

/**
 * Spinner - the app's single loading-ring primitive.
 *
 * Decorative by default (aria-hidden): most call sites pair it with visible
 * loading copy. Pass `label` for spinners that appear WITHOUT adjacent text so
 * assistive tech gets a status announcement instead of silence.
 */
function Spinner({ size = 'md', label, className = '' }) {
  return (
    <div
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={`animate-spin rounded-full border-stratosort-blue border-t-transparent ${
        SIZE_TO_CLASS[size] || SIZE_TO_CLASS.md
      } ${className}`}
    />
  );
}

Spinner.propTypes = {
  size: PropTypes.oneOf(['xs', 'md', 'lg']),
  label: PropTypes.string,
  className: PropTypes.string
};

export default Spinner;
