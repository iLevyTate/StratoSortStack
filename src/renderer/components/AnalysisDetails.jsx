import React, { memo, useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';
import { FileText, Info, Sparkles, Lightbulb, Tag, AlignLeft, Film } from 'lucide-react';
import { Text, Code, Caption } from './ui/Typography';
import { Stack } from './layout';
import StatusBadge from './ui/StatusBadge';
import Card from './ui/Card';
import Collapsible from './ui/Collapsible';
import { formatDisplayPath } from '../utils/pathDisplay';
import { formatMediaTimecode } from '../utils/format';

const isValuePresent = (value) => value !== null && value !== undefined && value !== '';

const truncateContent = (content, maxLength = 10000) => {
  if (typeof content !== 'string') return content;
  if (content.length <= maxLength) return content;
  return (
    content.slice(0, maxLength) +
    `... (${(content.length - maxLength).toLocaleString()} more characters)`
  );
};

const getPreviewText = (value, maxLength = 240) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}...`;
};

const getTextLength = (value) => (typeof value === 'string' ? value.length : 0);

const buildCollapsedPreview = (text, { maxLength = 240, mono = false, label } = {}) => {
  const preview = getPreviewText(text, maxLength);
  if (!preview) return null;
  return (
    <div className="space-y-1">
      <Text variant="small" className={`text-system-gray-600 ${mono ? 'font-mono' : ''}`.trim()}>
        {preview}
      </Text>
      <Text variant="tiny" className="text-system-gray-400">
        {label || `${getTextLength(text).toLocaleString()} characters`}
      </Text>
    </div>
  );
};

const DetailRow = ({ label, value, truncate = false }) => {
  if (!isValuePresent(value)) return null;
  return (
    <div className="flex flex-col gap-1.5 py-1.5">
      <Text variant="tiny" className="uppercase tracking-wider font-semibold text-system-gray-400">
        {label}
      </Text>
      <div className={`min-w-0 ${truncate ? 'truncate' : ''}`}>
        {typeof value === 'string' ? (
          <Text variant="small" className="text-system-gray-900">
            {value}
          </Text>
        ) : (
          value
        )}
      </div>
    </div>
  );
};

const SectionCard = ({ title, icon: Icon, children, className = '' }) => (
  <Card variant="static" className={`space-y-3 ${className}`.trim()}>
    <div className="flex items-center gap-compact">
      {Icon && (
        <span className="w-7 h-7 rounded-lg bg-stratosort-blue/10 text-stratosort-blue flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4" aria-hidden="true" />
        </span>
      )}
      <Caption className="text-system-gray-500">{title}</Caption>
    </div>
    {children}
  </Card>
);

const SectionHeader = ({ title, icon: Icon }) => (
  <span className="flex items-center gap-compact">
    {Icon && (
      <span className="w-7 h-7 rounded-lg bg-stratosort-blue/10 text-stratosort-blue flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4" aria-hidden="true" />
      </span>
    )}
    <span className="text-xs uppercase tracking-wider font-semibold text-system-gray-500">
      {title}
    </span>
  </span>
);

const MetaItem = ({ label, value, truncate = false }) => {
  if (!isValuePresent(value)) return null;
  return (
    <div className="rounded-lg border border-border-soft/70 bg-system-gray-100 px-3 py-2">
      <Text variant="tiny" className="uppercase tracking-wider font-semibold text-system-gray-400">
        {label}
      </Text>
      <div className={`min-w-0 ${truncate ? 'truncate' : ''}`}>
        {typeof value === 'string' ? (
          <Text variant="small" className="text-system-gray-800">
            {value}
          </Text>
        ) : (
          value
        )}
      </div>
    </div>
  );
};

const AnalysisDetails = memo(function AnalysisDetails({
  analysis,
  options = {},
  filePath,
  redactPaths = false
}) {
  // resolvedFilePath and hooks are placed before the early return to satisfy
  // React's rules of hooks (no hooks after conditional returns) and to avoid
  // a temporal dead zone in handleExportTranscript's closure.
  const resolvedFilePath =
    typeof filePath === 'string' && filePath.trim().length > 0
      ? filePath
      : typeof analysis?.path === 'string'
        ? analysis.path
        : '';

  const [exportStatus, setExportStatus] = useState('');

  const prevPathRef = useRef(resolvedFilePath);
  useEffect(() => {
    if (prevPathRef.current !== resolvedFilePath) {
      prevPathRef.current = resolvedFilePath;
      setExportStatus('');
    }
  }, [resolvedFilePath]);

  const handleExportTranscript = async (format) => {
    if (!resolvedFilePath) return;
    setExportStatus('');
    try {
      const result = await window.electronAPI?.analysisHistory?.exportTranscript?.(
        resolvedFilePath,
        format
      );
      if (result?.success) {
        setExportStatus(
          result?.truncated
            ? `Saved ${format.toUpperCase()} — long recording: transcript was truncated at 1,000 segments`
            : `Saved ${format.toUpperCase()}`
        );
      } else if (!result?.canceled) {
        setExportStatus(result?.error || 'Export failed');
      }
    } catch (err) {
      setExportStatus(err?.message || 'Export failed');
    }
  };

  if (!analysis || typeof analysis !== 'object') return null;

  const { showName = true, showCategory = true } = options || {};
  const displayFilePath = resolvedFilePath
    ? formatDisplayPath(resolvedFilePath, { redact: Boolean(redactPaths), segments: 2 })
    : '';

  const keywordList = Array.isArray(analysis.keywords)
    ? analysis.keywords.filter((k) => typeof k === 'string' && k.trim().length > 0).slice(0, 50) // Limit to 50 keywords to prevent rendering issues
    : [];
  const keywordPreview =
    keywordList.length > 0
      ? `${keywordList.slice(0, 6).join(', ')}${
          keywordList.length > 6 ? ` (+${keywordList.length - 6} more)` : ''
        }`
      : '';

  const confidenceValue =
    typeof analysis.confidence === 'number' && Number.isFinite(analysis.confidence)
      ? analysis.confidence
      : null;

  const displayConfidence =
    confidenceValue === null
      ? null
      : Math.max(
          0,
          confidenceValue <= 1 ? Math.round(confidenceValue * 100) : Math.round(confidenceValue)
        );

  const displayContentType =
    typeof analysis.content_type === 'object'
      ? analysis.content_type.mime || analysis.content_type.type || 'Unknown'
      : analysis.content_type || analysis.contentType;
  const rawType = typeof analysis.type === 'string' ? analysis.type.trim() : '';
  const isGenericType = ['image', 'document', 'file', 'unknown'].includes(rawType.toLowerCase());
  const documentType = analysis.documentType || (!isGenericType && rawType ? rawType : '');
  const displayDate = analysis.date || analysis.documentDate;
  const contentLength =
    typeof analysis.contentLength === 'number' && Number.isFinite(analysis.contentLength)
      ? `${analysis.contentLength.toLocaleString()} chars`
      : null;
  const confidenceBarValue =
    displayConfidence === null ? null : Math.min(100, Math.max(0, displayConfidence));
  const metadataItems = [
    { label: 'Entity', value: analysis.entity },
    { label: 'Project', value: analysis.project },
    { label: 'Purpose', value: analysis.purpose },
    { label: 'Date', value: displayDate },
    { label: 'Document type', value: documentType },
    { label: 'Content type', value: displayContentType },
    { label: 'Method', value: analysis.extractionMethod },
    { label: 'Length', value: contentLength }
  ].filter((item) => isValuePresent(item.value));
  const extractedTextLength =
    getTextLength(analysis.extractedText) +
    getTextLength(analysis.ocrText) +
    getTextLength(analysis.transcript) +
    getTextLength(analysis.multimodalText);
  const extractedPreviewSource =
    analysis.multimodalText ||
    analysis.extractedText ||
    analysis.ocrText ||
    analysis.transcript ||
    '';
  const keywordSectionOpen = keywordList.length <= 12;

  return (
    <Stack gap="relaxed" className="w-full">
      <SectionCard
        title="Overview"
        icon={FileText}
        className="bg-gradient-to-br from-system-gray-100 to-system-gray-50/80 border-border-soft/70"
      >
        <div className="flex flex-wrap items-start justify-between gap-default">
          <div className="min-w-[200px] flex-1 space-y-3">
            {showName && analysis.suggestedName && (
              <DetailRow
                label="Suggested name"
                value={<Code className="break-all">{analysis.suggestedName}</Code>}
              />
            )}
            {displayFilePath && (
              <DetailRow
                label="File path"
                value={
                  <Code className="break-all" title={redactPaths ? undefined : resolvedFilePath}>
                    {displayFilePath}
                  </Code>
                }
              />
            )}
          </div>
          <div className="flex flex-row sm:flex-col items-center sm:items-end gap-cozy flex-wrap">
            {showCategory && analysis.category && (
              <div className="flex items-center gap-compact">
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-400"
                >
                  Category
                </Text>
                <StatusBadge variant="info" size="sm" className="shadow-sm">
                  {analysis.category}
                </StatusBadge>
              </div>
            )}
            {displayConfidence !== null && (
              <div className="flex flex-col items-start sm:items-end gap-1">
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-400"
                >
                  Confidence
                </Text>
                <div className="flex items-center gap-compact">
                  <div className="w-28 h-2 bg-system-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        displayConfidence > 80
                          ? 'bg-stratosort-success'
                          : displayConfidence > 50
                            ? 'bg-stratosort-warning'
                            : 'bg-stratosort-danger'
                      }`}
                      style={{ width: `${confidenceBarValue}%` }}
                    />
                  </div>
                  <Text variant="small" className="font-medium text-system-gray-700">
                    {displayConfidence}%
                  </Text>
                </div>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      {metadataItems.length > 0 && (
        <SectionCard title="Metadata" icon={Info}>
          <div className="grid sm:grid-cols-2 gap-cozy">
            {metadataItems.map((item) => (
              <MetaItem key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        </SectionCard>
      )}

      {analysis.mediaKind && (
        <SectionCard title={analysis.mediaKind === 'video' ? 'Video' : 'Audio'} icon={Film}>
          <div className="grid sm:grid-cols-2 gap-cozy">
            <MetaItem label="Kind" value={analysis.mediaKind} />
            {Number.isFinite(analysis.durationSeconds) && analysis.durationSeconds > 0 && (
              <MetaItem label="Duration" value={formatMediaTimecode(analysis.durationSeconds)} />
            )}
            {analysis.detectedLanguage && (
              <MetaItem label="Language" value={analysis.detectedLanguage} />
            )}
            {Array.isArray(analysis.transcriptSegments) &&
              analysis.transcriptSegments.length > 0 && (
                <MetaItem
                  label="Transcript segments"
                  value={analysis.transcriptSegments.length.toLocaleString()}
                />
              )}
            {Array.isArray(analysis.keyframes) && analysis.keyframes.length > 0 && (
              <MetaItem label="Keyframes" value={analysis.keyframes.length.toLocaleString()} />
            )}
          </div>
          {Array.isArray(analysis.keyframes) &&
            analysis.keyframes.some((k) => k && typeof k.caption === 'string' && k.caption) && (
              <div className="mt-2">
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-500 mb-2"
                >
                  Keyframe captions
                </Text>
                <ul className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {analysis.keyframes
                    .filter((k) => k && typeof k.caption === 'string' && k.caption.trim())
                    .map((k, i) => (
                      <li
                        key={`${k.timestamp ?? 'na'}-${i}`}
                        className="flex gap-compact items-start rounded-md border border-border-soft/70 bg-system-gray-50 px-2.5 py-1.5"
                      >
                        <Code className="shrink-0 text-system-gray-500">
                          {Number.isFinite(k.timestamp) && k.timestamp >= 0
                            ? formatMediaTimecode(k.timestamp)
                            : '--:--'}
                        </Code>
                        <Text variant="small" className="text-system-gray-800 leading-snug">
                          {k.caption}
                        </Text>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          {analysis.mediaKind && !analysis.transcript && (
            <Text variant="tiny" className="text-system-gray-500 italic">
              No detectable speech in this file. Analysis used file metadata
              {Array.isArray(analysis.keyframes) &&
              analysis.keyframes.some((k) => k && typeof k.caption === 'string' && k.caption)
                ? ' and visual keyframes'
                : ''}
              .
            </Text>
          )}
        </SectionCard>
      )}

      {analysis.summary && (
        <Collapsible
          title={<SectionHeader title="Summary" icon={Sparkles} />}
          defaultOpen
          className="rounded-xl border border-border-soft/70 bg-gradient-to-br from-system-gray-50/80 to-system-gray-100"
          collapsedPreview={buildCollapsedPreview(analysis.summary, { maxLength: 220 })}
        >
          <Text variant="small" className="leading-relaxed text-system-gray-700">
            {truncateContent(analysis.summary, 2000)}
          </Text>
        </Collapsible>
      )}

      {analysis.reasoning && (
        <Collapsible
          title={<SectionHeader title="Reasoning" icon={Lightbulb} />}
          defaultOpen={false}
          className="rounded-xl border border-border-soft/70 bg-system-gray-100"
          collapsedPreview={buildCollapsedPreview(analysis.reasoning, { maxLength: 200 })}
        >
          <Text variant="small" className="leading-relaxed text-system-gray-700">
            {truncateContent(analysis.reasoning, 2000)}
          </Text>
        </Collapsible>
      )}

      {keywordList.length > 0 && (
        <Collapsible
          title={<SectionHeader title="Keywords" icon={Tag} />}
          defaultOpen={keywordSectionOpen}
          className="rounded-xl border border-border-soft/70 bg-system-gray-100"
          collapsedPreview={
            <Text variant="small" className="text-system-gray-600">
              {keywordPreview}
            </Text>
          }
        >
          <div className="flex flex-wrap gap-compact">
            {keywordList.map((keyword, i) => (
              <Text
                as="span"
                variant="tiny"
                key={i}
                className="px-2.5 py-1 bg-system-gray-100 border border-system-gray-200 rounded-full text-system-gray-600 font-medium shadow-sm"
              >
                {keyword}
              </Text>
            ))}
          </div>
        </Collapsible>
      )}

      {(analysis.ocrText ||
        analysis.transcript ||
        analysis.extractedText ||
        analysis.multimodalText) && (
        <Collapsible
          title={<SectionHeader title="Extracted text" icon={AlignLeft} />}
          defaultOpen={false}
          className="rounded-xl border border-border-soft/70 bg-system-gray-50/60"
          collapsedPreview={buildCollapsedPreview(extractedPreviewSource, {
            maxLength: 200,
            mono: true,
            label: extractedTextLength
              ? `${extractedTextLength.toLocaleString()} characters total`
              : undefined
          })}
          actions={
            extractedTextLength ? (
              <Text variant="tiny" className="text-system-gray-400">
                {extractedTextLength.toLocaleString()} chars
              </Text>
            ) : null
          }
        >
          <div className="space-y-3">
            {analysis.ocrText && (
              <div>
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-500 mb-1"
                >
                  OCR Text
                </Text>
                <Text
                  variant="tiny"
                  className="font-mono bg-system-gray-100 p-2 rounded border border-border-soft line-clamp-4"
                  title={
                    typeof analysis.ocrText === 'string' && analysis.ocrText.length > 10000
                      ? 'Content truncated for display'
                      : undefined
                  }
                >
                  {truncateContent(analysis.ocrText)}
                </Text>
              </div>
            )}
            {analysis.transcript && (
              <div>
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-500 mb-1"
                >
                  Transcript
                </Text>
                <div className="flex items-center gap-compact mb-1">
                  {['vtt', 'srt', 'json'].map((format) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => handleExportTranscript(format)}
                      disabled={!resolvedFilePath}
                      className="text-micro uppercase tracking-wide px-2 py-0.5 rounded border border-border-soft text-system-gray-600 hover:bg-system-gray-100 disabled:opacity-50"
                      aria-label={`Export transcript as ${format.toUpperCase()}`}
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                  {exportStatus && (
                    <span className="text-micro text-system-gray-500" role="status">
                      {exportStatus}
                    </span>
                  )}
                </div>
                <div
                  className="font-mono bg-system-gray-100 p-2 rounded border border-border-soft max-h-96 overflow-y-auto whitespace-pre-wrap"
                  title={
                    typeof analysis.transcript === 'string' && analysis.transcript.length > 10000
                      ? 'Content truncated for display'
                      : undefined
                  }
                >
                  <Text variant="tiny" className="text-system-gray-700">
                    {truncateContent(analysis.transcript)}
                  </Text>
                </div>
              </div>
            )}
            {analysis.multimodalText && (
              <div>
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-500 mb-1"
                >
                  Multimodal transcript (speech + visual)
                </Text>
                <div
                  className="font-mono bg-system-gray-100 p-2 rounded border border-border-soft max-h-96 overflow-y-auto whitespace-pre-wrap"
                  title={
                    typeof analysis.multimodalText === 'string' &&
                    analysis.multimodalText.length > 10000
                      ? 'Content truncated for display'
                      : undefined
                  }
                >
                  <Text variant="tiny" className="text-system-gray-700">
                    {truncateContent(analysis.multimodalText)}
                  </Text>
                </div>
              </div>
            )}
            {analysis.extractedText && (
              <div>
                <Text
                  variant="tiny"
                  className="uppercase tracking-wider font-semibold text-system-gray-500 mb-1"
                >
                  Extracted content
                </Text>
                <Text
                  variant="tiny"
                  className="font-mono bg-system-gray-100 p-2 rounded border border-border-soft line-clamp-4"
                  title={
                    typeof analysis.extractedText === 'string' &&
                    analysis.extractedText.length > 10000
                      ? 'Content truncated for display'
                      : undefined
                  }
                >
                  {truncateContent(analysis.extractedText)}
                </Text>
              </div>
            )}
          </div>
        </Collapsible>
      )}
    </Stack>
  );
});

AnalysisDetails.propTypes = {
  analysis: PropTypes.object,
  options: PropTypes.object,
  filePath: PropTypes.string,
  redactPaths: PropTypes.bool
};

export default AnalysisDetails;
