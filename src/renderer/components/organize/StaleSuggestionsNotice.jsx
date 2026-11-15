import React, { memo } from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';

/**
 * Files whose folder still comes from Smart Folder definitions that have
 * since changed (organizeDestination isStaleDestination). One button analyzes
 * them again with the current folders. While the re-rank with the new
 * folders is still running, it says so instead.
 */
function StaleSuggestionsNotice({
  count,
  isRanking = false,
  isAnalyzing = false,
  onRefresh,
  className = ''
}) {
  if (!count) return null;
  const one = count === 1;
  const files = `${count} ${one ? 'file' : 'files'}`;
  return (
    <div
      role="status"
      data-testid="stale-suggestions-notice"
      className={`flex items-start gap-compact rounded-xl border border-stratosort-warning/30 bg-stratosort-warning/12 px-3 py-2 ${className}`}
    >
      <AlertTriangle className="w-4 h-4 text-stratosort-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <Text variant="small" className="font-medium text-system-gray-800">
          {`Your Smart Folders changed after ${one ? 'this file was' : 'these files were'} analyzed`}
        </Text>
        <Text variant="tiny" className="text-system-gray-700 mt-0.5">
          {isRanking
            ? `Checking ${files} against your current Smart Folders.`
            : `${files} still ${one ? 'goes' : 'go'} where your old Smart Folders sent ${
                one ? 'it' : 'them'
              }. Analyze ${one ? 'it' : 'them'} again to sort ${
                one ? 'it' : 'them'
              } with the current folders.`}
        </Text>
      </div>
      {!isRanking && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={onRefresh}
          disabled={isAnalyzing}
          title={isAnalyzing ? 'Analysis is still running.' : undefined}
        >
          {`Analyze ${count} again`}
        </Button>
      )}
    </div>
  );
}

StaleSuggestionsNotice.propTypes = {
  count: PropTypes.number.isRequired,
  isRanking: PropTypes.bool,
  isAnalyzing: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  className: PropTypes.string
};

export default memo(StaleSuggestionsNotice);
