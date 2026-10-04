import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { Network, GitBranch, Copy, Activity, Inbox, FolderInput } from 'lucide-react';

/**
 * Persistent headline strip for Knowledge OS graph insights (above the canvas).
 */
export default function InsightDock({
  insightSummary,
  organizationalHealth,
  duplicateSummary,
  onStatClick,
  onHealthClick,
  onTriageClick = null,
  className = ''
}) {
  const activeFindings = useMemo(
    () => (organizationalHealth?.findings || []).filter((f) => f.active).length,
    [organizationalHealth?.findings]
  );

  const dupCount =
    duplicateSummary?.loading === true ? '…' : String(insightSummary?.nearDuplicates ?? 0);

  const clusterCount = insightSummary?.topicClusters ?? 0;
  const bridgeCount = insightSummary?.bridgeDocuments ?? 0;
  const scatteredCount = insightSummary?.scatteredFiles ?? 0;
  const healthGrade = organizationalHealth?.grade ?? '—';
  const healthScore = organizationalHealth?.score ?? 0;

  return (
    <div
      role="region"
      aria-label="Graph insights"
      className={`flex flex-wrap items-stretch gap-compact px-3 py-2 border-b border-system-gray-200 bg-system-gray-100/90 shrink-0 ${className}`}
    >
      <button
        type="button"
        onClick={() => onStatClick?.('clusters')}
        className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
        aria-label={`${clusterCount} topic clusters, click to explore`}
      >
        <Network className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-system-gray-900">{clusterCount}</span>
          <span className="block text-xs text-system-gray-500">Clusters</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onStatClick?.('bridges')}
        className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
        aria-label={`${bridgeCount} bridge documents, click to explore`}
      >
        <GitBranch className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-system-gray-900">{bridgeCount}</span>
          <span className="block text-xs text-system-gray-500">Bridges</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onStatClick?.('duplicates')}
        className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
        aria-label={`${dupCount} near-duplicate files, click to explore`}
      >
        <Copy className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-system-gray-900">{dupCount}</span>
          <span className="block text-xs text-system-gray-500">Near-dupes</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onStatClick?.('scattered')}
        className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
        aria-label={`${scatteredCount} scattered files, click to explore`}
      >
        <FolderInput className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-system-gray-900">{scatteredCount}</span>
          <span className="block text-xs text-system-gray-500">Scattered</span>
        </span>
      </button>
      {onTriageClick && (
        <button
          type="button"
          onClick={() => onTriageClick?.()}
          className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
          aria-label="Triage Downloads folder, click to open"
        >
          <Inbox className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-system-gray-900">Triage</span>
            <span className="block text-xs text-system-gray-500">Downloads</span>
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={() => onHealthClick?.()}
        className="flex min-w-[7.5rem] flex-1 items-center gap-compact rounded-xl border border-system-gray-200 bg-system-gray-50 shadow-sm px-3 py-2 text-left transition-colors hover:bg-system-gray-100 hover:shadow-md focus-ring"
        aria-label={`Organizational health grade ${healthGrade}, score ${healthScore}, ${activeFindings} active findings. Click to open details.`}
      >
        <Activity className="h-4 w-4 shrink-0 text-stratosort-blue" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-system-gray-900">
            {healthGrade} <span className="text-system-gray-500 font-normal">({healthScore})</span>
          </span>
          <span className="block text-xs text-system-gray-500">
            Health
            {activeFindings > 0
              ? ` · ${activeFindings} finding${activeFindings === 1 ? '' : 's'}`
              : ''}
          </span>
        </span>
      </button>
    </div>
  );
}

const summaryShape = PropTypes.shape({
  topicClusters: PropTypes.number,
  bridgeDocuments: PropTypes.number,
  nearDuplicates: PropTypes.number,
  scatteredFiles: PropTypes.number
});

const healthShape = PropTypes.shape({
  grade: PropTypes.string,
  score: PropTypes.number,
  findings: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string,
      label: PropTypes.string,
      active: PropTypes.bool
    })
  )
});

const dupShape = PropTypes.shape({
  loading: PropTypes.bool
});

InsightDock.propTypes = {
  insightSummary: summaryShape.isRequired,
  organizationalHealth: healthShape.isRequired,
  duplicateSummary: dupShape,
  onStatClick: PropTypes.func,
  onHealthClick: PropTypes.func,
  onTriageClick: PropTypes.func,
  className: PropTypes.string
};

InsightDock.defaultProps = {
  duplicateSummary: null,
  onStatClick: null,
  onHealthClick: null,
  onTriageClick: null,
  className: ''
};
