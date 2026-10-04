import React from 'react';
import PropTypes from 'prop-types';

/**
 * IconButton - Standardized icon button component
 * Provides consistent styling for icon-only buttons across the app
 *
 * @param {ReactNode} icon - The icon to display (can be SVG, emoji, or icon component)
 * @param {string} size - The button size (sm, md, lg)
 * @param {string} variant - The button variant (default, primary, secondary, ghost)
 * @param {string} className - Additional CSS classes
 * @param {string} aria-label - Required for accessibility - describes the button action
 */
function IconButton({
  icon,
  size = 'md',
  variant = 'default',
  className = '',
  disabled = false,
  type = 'button',
  'aria-label': ariaLabel,
  ...props
}) {
  const sizeClasses = {
    sm: 'h-9 w-9 text-sm',
    md: 'h-10 w-10 text-base',
    lg: 'h-12 w-12 text-lg'
  };

  const variantClasses = {
    default:
      'border border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:text-stratosort-blue hover:border-stratosort-blue/40 hover:bg-stratosort-blue/10 hover:shadow-md active:bg-stratosort-blue/12',
    primary:
      'bg-stratosort-blue text-white hover:bg-stratosort-blue/90 shadow-sm hover:shadow-md active:brightness-95',
    secondary:
      'border border-border-soft bg-system-gray-100/90 text-system-gray-700 hover:bg-system-gray-100 hover:border-stratosort-blue/30 hover:text-system-gray-900 shadow-sm active:bg-system-gray-200/80',
    ghost:
      'text-system-gray-600 hover:bg-system-gray-100/80 hover:text-system-gray-900 active:bg-system-gray-200/70'
  };

  return (
    <button
      // Default to `type="button"` so IconButton never accidentally triggers
      // an enclosing <form> submit (a classic footgun for icon-only controls
      // like close/cancel/search-clear buttons that happen to live inside a
      // form). Callers that really want a submit button can still pass
      // `type="submit"` explicitly.
      type={type}
      className={`
        inline-flex items-center justify-center
        rounded-full transition-colors transition-shadow [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2
        disabled:opacity-50 disabled:cursor-not-allowed
        ${sizeClasses[size]}
        ${variantClasses[variant]}
        ${className}
      `}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      disabled={disabled}
      {...props}
    >
      {icon}
    </button>
  );
}

IconButton.propTypes = {
  icon: PropTypes.node.isRequired,
  size: PropTypes.oneOf(['sm', 'md', 'lg']),
  variant: PropTypes.oneOf(['default', 'primary', 'secondary', 'ghost']),
  className: PropTypes.string,
  disabled: PropTypes.bool,
  type: PropTypes.oneOf(['button', 'submit', 'reset']),
  'aria-label': PropTypes.string.isRequired
};

export default IconButton;
