import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import PropTypes from 'prop-types';
import { TrendingUp, ClipboardList, Download, Folder, RefreshCw, FileText } from 'lucide-react';
import { List } from 'react-window';
import { createLogger } from '../../shared/logger';
import { useNotification } from '../contexts/NotificationContext';
import Modal, { ConfirmModal } from './ui/Modal';
import Button from './ui/Button';
import Card from './ui/Card';
import Spinner from './ui/Spinner';
import { Heading, Text } from './ui/Typography';
import { StatusBadge, StateMessage } from './ui';
import { Inline, Stack } from './layout';
import { nextRequestId, isCurrentRequest } from '../utils/requestGuard';
import { fetchAnalysisHistoryPages } from '../utils/analysisHistoryFetch';
import { formatMillisHuman } from '../utils/format';

const logger = createLogger('AnalysisHistoryModal');
function AnalysisHistoryModal({ onClose, analysisStats, setAnalysisStats }) {
  const { addNotification } = useNotification();
  const [historyData, setHistoryData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState('statistics');
  const hasLoadedRef = React.useRef(false);
  const isMountedRef = React.useRef(true);
  const loadRequestIdRef = React.useRef(0);
  const [isClearing, setIsClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadAnalysisData = useCallback(async () => {
    const requestId = nextRequestId(loadRequestIdRef);
    setIsLoading(true);

    let loadedCount = 0;
    const totalLoads = 2;

    const markLoaded = () => {
      if (!isCurrentRequest(loadRequestIdRef, requestId)) return;
      loadedCount++;
      if (loadedCount >= totalLoads && isMountedRef.current) {
        setIsLoading(false);
      }
    };

    const statsPromise = window.electronAPI?.analysisHistory?.getStatistics?.();
    if (statsPromise && typeof statsPromise.then === 'function') {
      statsPromise
        .then((stats) => {
          if (isMountedRef.current && isCurrentRequest(loadRequestIdRef, requestId)) {
            setAnalysisStats(stats);
          }
          return undefined;
        })
        .catch((error) => {
          if (isMountedRef.current && isCurrentRequest(loadRequestIdRef, requestId)) {
            logger.warn('Failed to load statistics', { error: error?.message });
          }
        })
        .finally(markLoaded);
    } else {
      markLoaded();
    }

    const historyPromise = fetchAnalysisHistoryPages({ maxEntries: 500 });
    if (historyPromise && typeof historyPromise.then === 'function') {
      historyPromise
        .then((history) => {
          if (!isMountedRef.current || !isCurrentRequest(loadRequestIdRef, requestId)) {
            return undefined;
          }
          setHistoryData(Array.isArray(history) ? history : []);
          return undefined;
        })
        .catch((error) => {
          if (isMountedRef.current && isCurrentRequest(loadRequestIdRef, requestId)) {
            addNotification('Failed to load analysis history', 'error');
            logger.warn('Failed to load history', { error: error?.message });
          }
        })
        .finally(markLoaded);
    } else {
      markLoaded();
    }
  }, [addNotification, setAnalysisStats]);

  useEffect(() => {
    if (hasLoadedRef.current) {
      return;
    }
    hasLoadedRef.current = true;
    loadAnalysisData();
  }, [loadAnalysisData]);

  const exportHistory = async (format) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportResponse = await window.electronAPI?.analysisHistory?.export?.(format);
      if (!exportResponse || exportResponse.success === false) {
        if (exportResponse?.canceled) return; // User canceled save dialog
        throw new Error(exportResponse?.error || 'Export failed');
      }
      addNotification(`Analysis history exported successfully`, 'success');
    } catch {
      addNotification('Export failed', 'error');
    } finally {
      if (isMountedRef.current) {
        setIsExporting(false);
      }
    }
  };

  const isClearingRef = useRef(false);
  const doClearHistory = useCallback(async () => {
    if (isClearingRef.current) return;
    isClearingRef.current = true;
    setIsClearing(true);
    try {
      const result = await window.electronAPI?.analysisHistory?.clear?.();
      if (result?.success === false) {
        throw new Error(result?.error || 'Failed to clear history');
      }
      await loadAnalysisData();
      addNotification('Analysis history cleared', 'success');
    } catch {
      addNotification('Failed to clear analysis history', 'error');
    } finally {
      isClearingRef.current = false;
      if (isMountedRef.current) {
        setIsClearing(false);
      }
    }
  }, [loadAnalysisData, addNotification]);

  const handleClearClick = useCallback(() => {
    setShowClearConfirm(true);
  }, []);

  const getDestinationLabel = useCallback((entry) => {
    try {
      const actual = entry?.organization?.actual;
      if (actual && typeof actual === 'string') {
        const normalized = actual.replace(/\\+/g, '/');
        const segments = normalized.split('/').filter(Boolean);
        if (segments.length > 1) {
          const last = segments[segments.length - 1];
          const isFile = /\.[A-Za-z0-9]+$/.test(last);
          const folder = isFile ? segments[segments.length - 2] : last;
          if (folder) return folder;
        }
      }
      if (entry?.organization?.smartFolder) return entry.organization.smartFolder;
      if (entry?.analysis?.category) return entry.analysis.category;
    } catch (error) {
      logger.debug('Error generating category label', { error: error.message });
    }
    return 'Uncategorized';
  }, []);

  const getConfidenceVariant = useCallback((confidence) => {
    if (!confidence) return 'info';
    if (confidence >= 90) return 'success';
    if (confidence >= 70) return 'info';
    if (confidence >= 50) return 'warning';
    return 'error';
  }, []);

  // Row height must include card padding (p-4), header block, optional tag chips (often wraps),
  // and pr-2 pb-3 on the row wrapper (pb-3 is inside the allocated height with border-box).
  const getRowHeight = useCallback(
    (index) => {
      const entry = historyData[index];
      if (!entry) return 112;
      const tagCount = Math.max(entry.keywords?.length || 0, entry.analysis?.tags?.length || 0);
      if (tagCount === 0) return 112;
      // Extra height when many chips so "+N more" and wrapped rows are not clipped.
      return tagCount > 4 ? 236 : 204;
    },
    [historyData]
  );

  const listHeight = useMemo(() => {
    let total = 0;
    for (let i = 0; i < Math.min(historyData.length, 10); i++) {
      total += getRowHeight(i);
    }
    return Math.min(Math.max(total, 200), 520);
  }, [historyData, getRowHeight]);

  const VirtualizedHistoryRow = React.memo(function VirtualizedHistoryRow({ index, style, data }) {
    const { historyData, getDestinationLabel, getConfidenceVariant } = data;
    const entry = historyData[index];
    if (!entry) return null;

    return (
      <div style={style} className="pr-2 pb-3">
        <Card
          key={entry.id || entry.filePath || entry.timestamp || entry.fileName}
          variant="interactive"
          className="p-4 min-h-0"
        >
          <div className="flex items-start gap-default">
            <div className="p-2.5 rounded-lg bg-system-gray-50 text-stratosort-blue border border-system-gray-100 shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-start gap-default mb-1">
                <div className="min-w-0">
                  <Text
                    variant="body"
                    className="font-medium text-system-gray-900 truncate"
                    title={entry.fileName}
                  >
                    {entry.fileName || 'Unknown file'}
                  </Text>
                  <Text
                    as="div"
                    variant="small"
                    className="flex items-center gap-compact mt-1 text-system-gray-500 flex-wrap"
                  >
                    <Text
                      as="span"
                      variant="tiny"
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-system-gray-50 border border-system-gray-100"
                    >
                      <Folder className="w-3 h-3" />
                      <span className="truncate max-w-[200px]">{getDestinationLabel(entry)}</span>
                    </Text>
                    <span className="text-system-gray-300">•</span>
                    <Text as="span" variant="tiny">
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleDateString()
                        : 'Unknown date'}
                    </Text>
                  </Text>
                </div>
                {(entry?.analysis?.confidence ?? entry?.confidence) != null && (
                  <StatusBadge
                    variant={getConfidenceVariant(entry?.analysis?.confidence ?? entry?.confidence)}
                    className="shrink-0"
                  >
                    {entry?.analysis?.confidence ?? entry?.confidence}% Match
                  </StatusBadge>
                )}
              </div>

              {(entry.keywords?.length > 0 || entry.analysis?.tags?.length > 0) && (
                <div className="flex flex-wrap gap-compact mt-3 pt-3 pb-1 border-t border-system-gray-50">
                  {(entry.keywords || entry.analysis?.tags || []).slice(0, 5).map((tag, idx) => (
                    <Text
                      as="span"
                      variant="tiny"
                      key={`${entry.id || entry.filePath || entry.timestamp}-kw-${idx}-${tag}`}
                      className="px-2 py-0.5 rounded-full bg-system-gray-50 text-system-gray-600 border border-system-gray-200"
                    >
                      {tag}
                    </Text>
                  ))}
                  {(entry.keywords?.length > 5 || entry.analysis?.tags?.length > 5) && (
                    <Text as="span" variant="tiny" className="px-2 py-0.5 text-system-gray-400">
                      +{(entry.keywords || entry.analysis?.tags || []).length - 5} more
                    </Text>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  });

  const rowProps = useMemo(
    () => ({
      data: {
        historyData,
        getDestinationLabel,
        getConfidenceVariant
      }
    }),
    [historyData, getDestinationLabel, getConfidenceVariant]
  );

  return (
    <>
      <Modal isOpen onClose={onClose} title="Analysis history & statistics" size="lg">
        <Stack gap="default">
          {/* Tabs */}
          <Inline gap="compact" className="border-b border-system-gray-200 pb-2">
            <Button
              onClick={() => setSelectedTab('statistics')}
              variant="ghost"
              size="sm"
              leftIcon={<TrendingUp className="w-4 h-4" />}
              className={
                selectedTab === 'statistics'
                  ? 'text-stratosort-blue bg-stratosort-blue/10 border-stratosort-blue/20'
                  : 'text-system-gray-600'
              }
            >
              Statistics
            </Button>
            <Button
              onClick={() => setSelectedTab('history')}
              variant="ghost"
              size="sm"
              leftIcon={<ClipboardList className="w-4 h-4" />}
              className={
                selectedTab === 'history'
                  ? 'text-stratosort-blue bg-stratosort-blue/10 border-stratosort-blue/20'
                  : 'text-system-gray-600'
              }
            >
              History
            </Button>
          </Inline>

          {/* Content */}
          <div className="min-h-[300px]">
            {isLoading ? (
              <div className="text-center p-8 animate-loading-fade">
                <div className="animate-loading-content">
                  <Spinner size="lg" className="mx-auto mb-4" />
                  <Text variant="small" className="text-system-gray-500">
                    Loading analysis data...
                  </Text>
                </div>
              </div>
            ) : (
              <>
                {selectedTab === 'statistics' && analysisStats && (
                  <Stack gap="relaxed" className="animate-fade-in">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-default">
                      <Card variant="default" className="text-center p-4">
                        <Heading as="div" variant="h3" className="text-stratosort-blue mb-1">
                          {analysisStats.totalFiles || 0}
                        </Heading>
                        <Text
                          variant="tiny"
                          className="text-system-gray-500 uppercase tracking-wide font-medium"
                        >
                          Total files
                        </Text>
                      </Card>
                      <Card variant="default" className="text-center p-4">
                        <Heading as="div" variant="h3" className="text-stratosort-success mb-1">
                          {Math.round(analysisStats.averageConfidence || 0)}%
                        </Heading>
                        <Text
                          variant="tiny"
                          className="text-system-gray-500 uppercase tracking-wide font-medium"
                        >
                          Avg confidence
                        </Text>
                      </Card>
                      <Card variant="default" className="text-center p-4">
                        <Heading as="div" variant="h3" className="text-stratosort-indigo mb-1">
                          {analysisStats.categoriesCount || 0}
                        </Heading>
                        <Text
                          variant="tiny"
                          className="text-system-gray-500 uppercase tracking-wide font-medium"
                        >
                          Categories
                        </Text>
                      </Card>
                      <Card variant="default" className="text-center p-4">
                        <Heading as="div" variant="h3" className="text-stratosort-warning mb-1">
                          {formatMillisHuman(analysisStats.averageProcessingTime || 0)}
                        </Heading>
                        <Text
                          variant="tiny"
                          className="text-system-gray-500 uppercase tracking-wide font-medium"
                        >
                          Avg time
                        </Text>
                      </Card>
                    </div>

                    <Card variant="default" className="p-4">
                      <div className="flex items-center gap-compact mb-4">
                        <Download className="w-4 h-4 text-system-gray-500" />
                        <Heading as="h4" variant="h6">
                          Export options
                        </Heading>
                      </div>
                      <Inline gap="cozy">
                        <Button
                          onClick={() => exportHistory('json')}
                          variant="secondary"
                          size="sm"
                          disabled={isExporting}
                          isLoading={isExporting}
                        >
                          Export JSON
                        </Button>
                        <Button
                          onClick={() => exportHistory('csv')}
                          variant="secondary"
                          size="sm"
                          disabled={isExporting}
                          isLoading={isExporting}
                        >
                          Export CSV
                        </Button>
                        <div className="flex-1" />
                        <Button
                          onClick={handleClearClick}
                          variant="danger"
                          size="sm"
                          disabled={isClearing}
                        >
                          {isClearing ? 'Clearing...' : 'Clear history'}
                        </Button>
                      </Inline>
                    </Card>
                  </Stack>
                )}
                {selectedTab === 'history' && (
                  <Stack gap="default" className="animate-fade-in">
                    <div className="flex justify-between items-center">
                      <div>
                        <Heading as="h4" variant="h6">
                          Recent analysis
                        </Heading>
                        {historyData.length >= 500 && (
                          <Text variant="small" className="text-system-gray-400 mt-0.5">
                            Showing latest 500 entries. Export for full history.
                          </Text>
                        )}
                      </div>
                      <Button
                        onClick={loadAnalysisData}
                        variant="ghost"
                        size="sm"
                        className="text-system-gray-500 hover:text-stratosort-blue h-8"
                      >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                        Refresh
                      </Button>
                    </div>

                    <div className="flex-1 min-h-0">
                      {historyData.length > 0 ? (
                        <List
                          rowCount={historyData.length}
                          rowHeight={getRowHeight}
                          rowComponent={VirtualizedHistoryRow}
                          rowProps={rowProps}
                          overscanCount={5}
                          style={{ height: listHeight, width: '100%' }}
                          className="scrollbar-thin scrollbar-thumb-system-gray-300 scrollbar-track-transparent"
                        />
                      ) : (
                        <StateMessage
                          icon={Folder}
                          tone="neutral"
                          size="lg"
                          title="No analysis history yet"
                          description="Run an analysis to see recent activity and export options here."
                          className="p-8 border-2 border-dashed border-system-gray-200 rounded-xl bg-system-gray-50/50"
                          contentClassName="max-w-xs"
                        />
                      )}
                    </div>
                  </Stack>
                )}
              </>
            )}
          </div>
        </Stack>
      </Modal>

      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={doClearHistory}
        title="Clear all history?"
        message="This will permanently delete all analysis history and statistics. This action cannot be undone."
        confirmText="Clear all"
        cancelText="Cancel"
        variant="danger"
      />
    </>
  );
}

AnalysisHistoryModal.propTypes = {
  onClose: PropTypes.func.isRequired,
  analysisStats: PropTypes.shape({
    totalFiles: PropTypes.number,
    averageConfidence: PropTypes.number,
    categoriesCount: PropTypes.number,
    averageProcessingTime: PropTypes.number
  }),
  setAnalysisStats: PropTypes.func.isRequired
};

export default AnalysisHistoryModal;
