import React from 'react';
import PropTypes from 'prop-types';
import { Heading, Text } from '../ui/Typography';

/**
 * Standard layout for a setting row.
 * Displays label and description on the left, and the control (switch, input, etc.) on the right/bottom.
 */
function SettingRow({ label, description, children, className = '', layout = 'row' }) {
  // layout 'row' puts control on the right (good for switches)
  // layout 'col' puts control below description (good for inputs/selects)
  const isRow = layout === 'row';
  const containerClass = isRow
    ? 'flex flex-col gap-cozy sm:flex-row sm:items-start sm:justify-between sm:gap-relaxed'
    : 'flex flex-col gap-2.5';
  const descriptionClass = label
    ? 'mt-1 text-system-gray-500 leading-relaxed'
    : 'text-system-gray-500';

  return (
    <div className={`${containerClass} ${className}`.trim()}>
      <div className={`${isRow ? 'flex-1' : ''} min-w-0`}>
        {label && (
          <Heading as="h3" variant="h6" className="text-system-gray-900 tracking-tight">
            {label}
          </Heading>
        )}
        {description && (
          <Text variant="small" className={descriptionClass}>
            {description}
          </Text>
        )}
      </div>
      <div className={isRow ? 'w-full sm:w-auto sm:flex-shrink-0 sm:pt-0.5' : 'w-full max-w-2xl'}>
        {children}
      </div>
    </div>
  );
}

SettingRow.propTypes = {
  label: PropTypes.node,
  description: PropTypes.node,
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
  layout: PropTypes.oneOf(['row', 'col'])
};

export default SettingRow;
