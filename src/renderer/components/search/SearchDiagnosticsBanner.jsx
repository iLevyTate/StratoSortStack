import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle } from 'lucide-react';
import { Text } from '../ui/Typography';
import { normalizeSearchWarnings } from './utils/searchWarnings';

function SearchDiagnosticsBanner({ meta }) {
  const warnings = normalizeSearchWarnings(meta?.warnings).slice(0, 3);
  if (warnings.length === 0) return null;

  return (
    <div className="glass-panel border border-stratosort-warning/30 bg-stratosort-warning/5 px-3 py-2 rounded-lg">
      <div className="flex items-start gap-compact">
        <AlertTriangle className="w-4 h-4 text-stratosort-warning shrink-0 mt-0.5" />
        <div className="flex flex-col gap-1">
          <Text as="span" variant="tiny" className="text-system-gray-700 font-medium">
            Search diagnostics
          </Text>
          {warnings.map((warning, index) => (
            <Text
              key={`${warning.type}-${index}`}
              as="span"
              variant="tiny"
              className="text-system-gray-600"
            >
              {warning.message}
            </Text>
          ))}
        </div>
      </div>
    </div>
  );
}

SearchDiagnosticsBanner.propTypes = {
  meta: PropTypes.shape({
    warnings: PropTypes.arrayOf(
      PropTypes.shape({
        type: PropTypes.string,
        severity: PropTypes.string,
        message: PropTypes.string
      })
    )
  })
};
SearchDiagnosticsBanner.displayName = 'SearchDiagnosticsBanner';

export default SearchDiagnosticsBanner;
