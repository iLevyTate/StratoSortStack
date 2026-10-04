import React from 'react';
import PropTypes from 'prop-types';
import Card from '../ui/Card';
import { Text } from '../ui/Typography';

/**
 * Consistent settings section card wrapper.
 * Ensures all settings cards share the same structure, spacing, and typography.
 */
function SettingsCard({ title, description, headerAction, children, className = '', ...rest }) {
  return (
    <Card
      variant="default"
      className={`settings-card rounded-2xl space-y-5 border border-border-soft/70 bg-system-gray-100/80 shadow-sm ${className}`.trim()}
      {...rest}
    >
      <div className="flex flex-col gap-compact sm:flex-row sm:items-start sm:justify-between sm:gap-default">
        <div className="min-w-0">
          <Text variant="small" className="font-semibold tracking-tight text-system-gray-900">
            {title}
          </Text>
          <Text variant="tiny" className="text-system-gray-500 mt-1 leading-relaxed">
            {description}
          </Text>
        </div>
        {headerAction && (
          <div className="flex flex-shrink-0 items-center gap-compact">{headerAction}</div>
        )}
      </div>
      {children}
    </Card>
  );
}

SettingsCard.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string.isRequired,
  headerAction: PropTypes.node,
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
  id: PropTypes.string
};

export default SettingsCard;
