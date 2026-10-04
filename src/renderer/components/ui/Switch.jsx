import React from 'react';
import PropTypes from 'prop-types';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('Switch');

const Switch = ({
  checked,
  onChange,
  disabled = false,
  className = '',
  ref,
  'aria-label': ariaLabel,
  ...props
}) => {
  if (process.env.NODE_ENV === 'development' && !ariaLabel) {
    logger.warn(
      '[Switch] Missing aria-label: screen readers cannot identify what this toggle controls'
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-stratosort-blue focus:ring-offset-2
        ${checked ? 'bg-stratosort-blue' : 'bg-system-gray-200'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
      ref={ref}
      {...props}
    >
      <span
        aria-hidden="true"
        className={`
          pointer-events-none inline-block h-5 w-5 transform rounded-full bg-system-gray-900 shadow ring-0 transition duration-200 ease-in-out
          ${checked ? 'translate-x-5' : 'translate-x-0'}
        `}
      />
    </button>
  );
};

Switch.displayName = 'Switch';

Switch.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  'aria-label': PropTypes.string
};

export default Switch;
