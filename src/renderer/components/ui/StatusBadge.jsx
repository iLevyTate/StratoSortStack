import React from 'react';
import PropTypes from 'prop-types';

/**
 * StatusBadge - Standardized status indicator component
 * Provides consistent styling for status indicators across the app
 *
 * @param {string} variant - The status variant (success, warning, error, info)
 * @param {ReactNode} children - The content to display
 * @param {boolean} animated - Whether to show pulse animation
 * @param {string} className - Additional CSS classes
 */
function StatusBadge({
  variant = 'info',
  size = 'md',
  appearance = 'tint',
  children,
  animated = false,
  className = ''
}) {
  const variantClasses = {
    success: 'bg-stratosort-success/10 text-stratosort-success border-stratosort-success/50',
    warning: 'bg-stratosort-warning/10 text-stratosort-warning border-stratosort-warning/50',
    error: 'bg-stratosort-danger/10 text-stratosort-danger border-stratosort-danger/50',
    info: 'bg-stratosort-blue/10 text-stratosort-blue border-stratosort-blue/45'
  };
  const sizeClasses = {
    sm: 'text-xs px-2.5 py-1',
    md: 'text-sm px-3.5 py-2'
  };

  // 'label' is the uppercase micro-chip recipe (save-status / mode chips),
  // extracted verbatim from its duplicated call sites so adoption is
  // pixel-identical. It ignores `size` — the recipe has exactly one size.
  if (appearance === 'label') {
    const labelVariantClasses = {
      success: 'border-stratosort-success/30 bg-stratosort-success/10 text-stratosort-success',
      warning: 'border-stratosort-warning/30 bg-stratosort-warning/10 text-stratosort-warning',
      error: 'border-stratosort-danger/30 bg-stratosort-danger/10 text-stratosort-danger',
      info: 'border-stratosort-blue/30 bg-stratosort-blue/10 text-stratosort-blue',
      neutral: 'border-border-soft bg-system-gray-100 text-system-gray-500'
    };
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-micro font-semibold uppercase tracking-wide ${labelVariantClasses[variant] || labelVariantClasses.info} ${className}`}
      >
        {animated && <span className="w-2 h-2 rounded-full bg-current animate-pulse" />}
        {children}
      </span>
    );
  }

  return (
    <div
      className={`
        inline-flex items-center gap-compact rounded-full
        font-medium border leading-tight
        ${variantClasses[variant] || variantClasses.info}
        ${sizeClasses[size] || sizeClasses.md}
        ${className}
      `}
    >
      {animated && <span className="w-2.5 h-2.5 rounded-full bg-current animate-pulse" />}
      {children}
    </div>
  );
}

StatusBadge.propTypes = {
  variant: PropTypes.oneOf(['success', 'warning', 'error', 'info', 'neutral']),
  size: PropTypes.oneOf(['sm', 'md']),
  appearance: PropTypes.oneOf(['tint', 'label']),
  children: PropTypes.node,
  animated: PropTypes.bool,
  className: PropTypes.string
};

export default StatusBadge;
