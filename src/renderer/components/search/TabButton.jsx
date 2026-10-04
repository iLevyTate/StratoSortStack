import React from 'react';
import PropTypes from 'prop-types';
import { Button } from '../ui';

function TabButton({ active, onClick, icon: Icon, label, tooltip }) {
  return (
    <Button
      type="button"
      onClick={onClick}
      variant={active ? 'primary' : 'ghost'}
      aria-pressed={active}
      size="sm"
      leftIcon={<Icon className="w-4 h-4" />}
      className={`rounded-lg ${active ? 'shadow-sm' : 'text-system-gray-500 hover:text-system-gray-800'}`}
      title={tooltip}
    >
      {label}
    </Button>
  );
}

TabButton.propTypes = {
  active: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  tooltip: PropTypes.string
};
TabButton.displayName = 'TabButton';

export default TabButton;
