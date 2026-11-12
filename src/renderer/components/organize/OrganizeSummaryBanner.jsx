import React from 'react';
import PropTypes from 'prop-types';
import { AlertCircle, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { IconButton } from '../ui';
import { Text } from '../ui/Typography';

const TONES = {
  success: {
    container: 'bg-stratosort-success/10 border-stratosort-success/25',
    icon: 'text-stratosort-success',
    Icon: CheckCircle2
  },
  warning: {
    container: 'bg-stratosort-warning/12 border-stratosort-warning/30',
    icon: 'text-stratosort-warning',
    Icon: AlertTriangle
  },
  danger: {
    container: 'bg-stratosort-danger/10 border-stratosort-danger/30',
    icon: 'text-stratosort-danger',
    Icon: AlertCircle
  }
};

const TONE_BY_OUTCOME = {
  moved: 'success',
  partial: 'warning',
  none: 'danger',
  rolledBack: 'danger'
};

/** How the last organize run ended, shown above the file list. */
function OrganizeSummaryBanner({ summary, onDismiss }) {
  const toneName = TONE_BY_OUTCOME[summary.outcome] || 'success';
  const { container, icon, Icon } = TONES[toneName];
  const urgent = toneName === 'danger';
  const detail =
    summary.detail ||
    (summary.outcome === 'moved'
      ? 'You can review organized files in the status panel or continue with the next batch.'
      : '');

  return (
    <div
      className={`flex items-start gap-cozy rounded-xl border px-4 py-3 text-sm text-system-gray-800 ${container}`}
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      data-testid="organize-summary-banner"
      data-outcome={summary.outcome}
    >
      <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Text as="span" variant="small" className="font-medium text-system-gray-900">
          {summary.headline}
        </Text>
        {detail && (
          <Text as="div" variant="tiny" className="text-system-gray-600 mt-0.5 break-words">
            {detail}
          </Text>
        )}
      </div>
      <IconButton
        onClick={onDismiss}
        variant="ghost"
        size="sm"
        aria-label="Dismiss"
        icon={<X className="w-4 h-4" />}
      />
    </div>
  );
}

OrganizeSummaryBanner.propTypes = {
  summary: PropTypes.shape({
    outcome: PropTypes.oneOf(['moved', 'partial', 'none', 'rolledBack']).isRequired,
    headline: PropTypes.string.isRequired,
    detail: PropTypes.string
  }).isRequired,
  onDismiss: PropTypes.func.isRequired
};

export default OrganizeSummaryBanner;
