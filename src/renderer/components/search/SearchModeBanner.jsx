import React from 'react';
import PropTypes from 'prop-types';
import { MessageSquare } from 'lucide-react';
import { Text } from '../ui/Typography';

function SearchModeBanner({ meta }) {
  if (!meta?.fallback) return null;

  return (
    <div className="glass-panel border border-stratosort-warning/30 bg-stratosort-warning/5 px-3 py-2 rounded-lg flex items-center gap-compact">
      <MessageSquare className="w-4 h-4 text-stratosort-warning shrink-0" />
      <Text as="span" variant="tiny" className="text-system-gray-600">
        <strong>Limited search:</strong> Using keyword search only
        {meta.fallbackReason ? ` (${meta.fallbackReason})` : ' (embedding model unavailable)'}.
        Knowledge OS semantic matching is disabled.
      </Text>
    </div>
  );
}

SearchModeBanner.propTypes = {
  meta: PropTypes.shape({
    mode: PropTypes.string,
    fallback: PropTypes.bool,
    fallbackReason: PropTypes.string,
    originalMode: PropTypes.string,
    warnings: PropTypes.arrayOf(
      PropTypes.shape({
        type: PropTypes.string,
        severity: PropTypes.string,
        message: PropTypes.string
      })
    )
  })
};
SearchModeBanner.displayName = 'SearchModeBanner';

export default SearchModeBanner;
