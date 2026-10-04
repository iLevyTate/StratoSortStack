import React, { memo } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button';
import { Inline } from '../layout';

const SelectionControls = memo(function SelectionControls({
  onSelectFiles,
  onSelectFolder,
  isScanning,
  className = ''
}) {
  return (
    <Inline gap="relaxed" className={`justify-center ${className}`}>
      <Button onClick={onSelectFiles} variant="primary" size="sm" disabled={isScanning}>
        Select files
      </Button>
      <Button onClick={onSelectFolder} variant="secondary" size="sm" disabled={isScanning}>
        Scan folder
      </Button>
      {isScanning && (
        <span className="sr-only" role="status" aria-live="polite">
          Scanning files...
        </span>
      )}
    </Inline>
  );
});

SelectionControls.propTypes = {
  onSelectFiles: PropTypes.func.isRequired,
  onSelectFolder: PropTypes.func.isRequired,
  isScanning: PropTypes.bool,
  className: PropTypes.string
};

export default SelectionControls;
