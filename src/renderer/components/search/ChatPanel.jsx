import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import {
  Send,
  RefreshCw,
  FileText,
  AlertTriangle,
  RotateCcw,
  ArrowUpRight,
  Square,
  Settings2,
  Image,
  FileSpreadsheet,
  File,
  Lightbulb,
  Tag,
  Users
} from 'lucide-react';
import { AlertBox, Button, Textarea, Switch, StateMessage, Select } from '../ui';
import { Text } from '../ui/Typography';
import { formatDisplayPath } from '../../utils/pathDisplay';
import normalizeList from '../../utils/normalizeList';
import { selectRedactPaths } from '../../store/selectors';
import { CHAT_PERSONAS, DEFAULT_CHAT_PERSONA_ID } from '../../../shared/chatPersonas';
import CitationRenderer from './CitationRenderer';
import ContradictionCard from './ContradictionCard';
import ComparisonTable from './ComparisonTable';
import GapAnalysisCard from './GapAnalysisCard';

/** Default persona list when parent does not pass merged built-in + custom options. */
const DEFAULT_PERSONA_OPTIONS = CHAT_PERSONAS;

function normalizeImageSource(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:')) {
    return trimmed;
  }
  if (lower.startsWith('file://')) {
    return trimmed;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return trimmed;
}

function ThinkingDots() {
  return (
    <span className="thinking-dots" aria-hidden="true">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </span>
  );
}

/** Placeholder lines while the assistant stream has not produced visible text yet */
function StreamingAnswerSkeleton() {
  return (
    <div className="space-y-2 pt-1" aria-hidden="true">
      <div className="h-2.5 max-w-xl rounded-md bg-system-gray-200/85 animate-pulse w-[92%]" />
      <div className="h-2.5 max-w-xl rounded-md bg-system-gray-200/85 animate-pulse w-[76%]" />
      <div className="h-2.5 max-w-xl rounded-md bg-system-gray-200/85 animate-pulse w-[84%]" />
    </div>
  );
}

function ChatWarningBanner({ message, action }) {
  if (!message && !action) return null;
  return (
    <AlertBox variant="warning">
      <div className="flex flex-wrap items-center justify-between gap-compact">
        <span className="flex-1 min-w-0">{message}</span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </div>
    </AlertBox>
  );
}

function ChatModeToggle({ value, onChange }) {
  const isFast = value === 'fast';
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-full border border-border-soft bg-system-gray-100/90 p-1"
      role="group"
      aria-label="Response mode"
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onChange('fast')}
        title="Quick response with keyword expansion and spell check"
        aria-pressed={isFast}
        className={`rounded-full px-2.5 ${
          isFast
            ? 'bg-system-gray-100 text-system-gray-900 shadow-sm ring-1 ring-stratosort-blue/15'
            : 'bg-transparent text-system-gray-500 hover:bg-system-gray-100/70 hover:text-system-gray-700'
        }`}
      >
        Fast
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onChange('deep')}
        title="Slower, more accurate response with LLM re-ranking"
        aria-pressed={!isFast}
        className={`rounded-full px-2.5 ${
          !isFast
            ? 'bg-system-gray-100 text-system-gray-900 shadow-sm ring-1 ring-stratosort-blue/15'
            : 'bg-transparent text-system-gray-500 hover:bg-system-gray-100/70 hover:text-system-gray-700'
        }`}
      >
        Deep
      </Button>
    </div>
  );
}

/** Pick an icon component based on the document type string. Cached by lowercase key. */
const _iconCache = new Map();
const ICON_CACHE_MAX_ENTRIES = 128;
function docTypeIcon(documentType) {
  if (!documentType) return File;
  const lower = documentType.toLowerCase();
  const cached = _iconCache.get(lower);
  if (cached) return cached;
  let icon = FileText;
  if (lower.includes('image') || lower.includes('photo') || lower.includes('picture')) icon = Image;
  else if (lower.includes('spreadsheet') || lower.includes('csv') || lower.includes('excel'))
    icon = FileSpreadsheet;
  if (_iconCache.size >= ICON_CACHE_MAX_ENTRIES) {
    _iconCache.clear();
  }
  _iconCache.set(lower, icon);
  return icon;
}

function getPathBasename(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function normalizeAnswerTextForComparison(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function replaceKnownSourcePaths(text, sources) {
  if (typeof text !== 'string' || !Array.isArray(sources) || sources.length === 0) {
    return text;
  }

  let nextText = text;
  const replacements = sources
    .map((source) => {
      const path = typeof source?.path === 'string' ? source.path.trim() : '';
      if (!path) return null;
      return {
        path,
        replacement: source.name || source.fileId || getPathBasename(path) || 'this document'
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.path.length - a.path.length);

  replacements.forEach(({ path, replacement }) => {
    nextText = nextText.split(path).join(replacement);

    const normalizedPath = path.replace(/\\/g, '/');
    const fileUri = /^[a-z]:\//i.test(normalizedPath)
      ? `file:///${normalizedPath}`
      : normalizedPath.startsWith('/')
        ? `file://${normalizedPath}`
        : '';

    if (fileUri) {
      nextText = nextText.split(fileUri).join(replacement);
    }
  });

  return nextText;
}

function sanitizeAnswerText(text, sources) {
  if (typeof text !== 'string') return '';

  const textWithKnownSourcesRedacted = replaceKnownSourcePaths(text, sources);

  return textWithKnownSourcesRedacted
    .replace(/file:\/\/\/?([A-Za-z]:\/[^\s"'<>|)]+|\/[^\s"'<>|)]+)/gi, (match, pathPart) => {
      return getPathBasename(pathPart || match) || 'this document';
    })
    .replace(/\b[A-Za-z]:[\\/](?:[^\\/\r\n\t"'<>|]+[\\/])*[^\\/\r\n\t"'<>|)]+/g, (match) => {
      return getPathBasename(match) || 'this document';
    });
}

function getAnswerItems(items, sources) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();

  return items
    .filter((item) => typeof item?.text === 'string' && item.text.trim())
    .map((item) => ({
      ...item,
      text: sanitizeAnswerText(item.text, sources)
    }))
    .filter((item) => {
      const normalizedText = normalizeAnswerTextForComparison(item.text);
      if (!normalizedText) return false;
      // Dedupe by (text + citations) rather than text alone: two answers can
      // share identical prose but cite different documents, in which case
      // they're semantically distinct evidence and must both render.
      // Previously the second one was silently dropped.
      const citationKey = Array.isArray(item.citations) ? [...item.citations].sort().join('|') : '';
      const key = `${normalizedText} ${citationKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getPrimaryAnswerItems(message) {
  const sources = Array.isArray(message?.sources) ? message.sources : [];
  const documentItems = getAnswerItems(message?.documentAnswer, sources);
  if (documentItems.length > 0) return documentItems;
  return getAnswerItems(message?.modelAnswer, sources);
}

// Inline `[doc-N]` citation tokens (optionally preceded by whitespace).
const INLINE_CITATION_RE = /[ \t]*\[doc-(\d+)\]/g;

// Drop `[doc-N]` tokens that can't be resolved to a numbered source. This
// matters chiefly while streaming: the raw model buffer contains citations but
// `message.sources` isn't attached until the stream completes, so an unresolved
// token would otherwise render as a broken `[?]`. Resolvable tokens are kept so
// the strip stays correct if sources ever arrive before the final chunk.
// Placeholder for a just-stripped token so whitespace healing can target ONLY
// the removal sites: the old global `\s+([.,;:!?])` (which matches newlines)
// and `[ \t]{2,}` passes collapsed intentional spacing across the entire
// whitespace-pre-wrap bubble mid-stream, and the layout shifted again when the
// finished message swapped to the structured answer.
const STRIP_MARKER = '\u0000';
const MARKER_BEFORE_PUNCT_RE = new RegExp(`${STRIP_MARKER}[ \\t]*([.,;:!?])`, 'g');
const MARKER_RE = new RegExp(STRIP_MARKER, 'g');

function stripUnresolvedCitations(text, sources) {
  if (typeof text !== 'string' || !text.includes('[doc-')) return text;
  const sourceIds = new Set((sources || []).map((s) => s?.id));
  const marked = text.replace(INLINE_CITATION_RE, (match, num) =>
    sourceIds.has(`doc-${num}`) ? match : STRIP_MARKER
  );
  if (!marked.includes(STRIP_MARKER)) return marked;
  return marked
    .replace(MARKER_BEFORE_PUNCT_RE, '$1') // "fact <stripped> ." -> "fact."
    .replace(MARKER_RE, '')
    .trim();
}

function getAssistantDisplayText(message) {
  if (typeof message?.text === 'string' && message.text.trim()) {
    // Streaming path: the finished message swaps `.text` for the structured,
    // source-reconciled answer, so this branch only renders mid-stream text.
    return stripUnresolvedCitations(
      sanitizeAnswerText(message.text, message.sources),
      message.sources
    );
  }

  return getPrimaryAnswerItems(message)
    .map((item) => item.text)
    .join('\n\n');
}

const LONG_THREAD_MESSAGE_THRESHOLD = 45;

const SourceList = React.memo(function SourceList({ sources, onOpenSource }) {
  if (!sources || sources.length === 0) {
    return (
      <StateMessage
        icon={FileText}
        tone="neutral"
        size="sm"
        align="left"
        title="No matching documents found."
        className="mt-3"
      />
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {sources.map((source, index) => {
        const tags = normalizeList(source.tags).slice(0, 4);
        const entities = normalizeList(source.entities).slice(0, 4);
        const rawSemantic =
          typeof source.semanticScore === 'number' ? source.semanticScore : source.score;
        const scorePct = typeof rawSemantic === 'number' ? Math.round(rawSemantic * 100) : 0;
        const imageSrc = normalizeImageSource(
          source.previewImage || source.imagePath || source.thumbnail || source.image
        );
        const Icon = docTypeIcon(source.documentType);

        // Prefer summary, then purpose, then reasoning for the description line
        const description = source.summary || source.purpose || source.reasoning || '';
        // Build a concise type + category badge
        const typeParts = [];
        if (source.documentType) typeParts.push(source.documentType);
        if (source.category && source.category !== source.documentType)
          typeParts.push(source.category);
        const typeLabel = typeParts.join(' · ');

        return (
          <div
            key={source.id || source.path || source.fileId || `${source.name || 'source'}-${index}`}
            className="rounded-lg border border-border-soft bg-system-gray-100/90 shadow-sm transition-colors hover:border-stratosort-blue/20"
          >
            {/* Header row: icon + name + score + open button */}
            <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-1.5">
              <div
                className={`p-1.5 rounded-md shrink-0 ${
                  scorePct >= 70
                    ? 'bg-stratosort-success/10'
                    : scorePct >= 50
                      ? 'bg-stratosort-blue/10'
                      : 'bg-system-gray-100'
                }`}
              >
                <Icon
                  className={`w-3.5 h-3.5 ${
                    scorePct >= 70
                      ? 'text-stratosort-success'
                      : scorePct >= 50
                        ? 'text-stratosort-blue'
                        : 'text-system-gray-400'
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <Text variant="small" className="font-semibold text-system-gray-900 truncate">
                  {source.name || source.fileId || 'Untitled document'}
                </Text>
                {(typeLabel || source.project) && (
                  <Text as="div" variant="tiny" className="text-system-gray-500 truncate">
                    {[typeLabel, source.project].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </div>
              <Text
                as="span"
                variant="tiny"
                className={`font-bold tabular-nums shrink-0 px-1.5 py-0.5 rounded-full ${
                  scorePct >= 70
                    ? 'bg-stratosort-success/10 text-stratosort-success'
                    : scorePct >= 50
                      ? 'bg-stratosort-blue/10 text-stratosort-blue'
                      : 'bg-system-gray-100 text-system-gray-400'
                }`}
              >
                {scorePct}%
              </Text>
              {source.path ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenSource(source)}
                  title="Open source file"
                  className="shrink-0 -mr-1"
                  aria-label={`Open source file${source.name ? `: ${source.name}` : ''}`}
                >
                  <FileText className="w-4 h-4" />
                </Button>
              ) : null}
            </div>

            {/* Subject line — most descriptive single field */}
            {source.subject && (
              <div className="px-3 pb-1">
                <Text as="div" variant="tiny" className="font-medium text-system-gray-700">
                  {source.subject}
                </Text>
              </div>
            )}

            {/* Description: summary / purpose / reasoning */}
            {description && (
              <div className="px-3 pb-1.5">
                <Text
                  as="div"
                  variant="tiny"
                  className="text-system-gray-600 leading-relaxed line-clamp-2"
                >
                  {description}
                </Text>
              </div>
            )}

            {/* Snippet — quoted excerpt if no description is available, or always for images */}
            {source.snippet && (!description || source.isImage) && (
              <div className="mx-3 mb-1.5 p-2 bg-system-gray-50 rounded-md border border-system-gray-100">
                <Text
                  as="div"
                  variant="tiny"
                  className="text-system-gray-600 italic line-clamp-2 leading-relaxed"
                >
                  &ldquo;{source.snippet}&rdquo;
                </Text>
              </div>
            )}

            {/* Image preview for image-type documents */}
            {imageSrc && (
              <div className="px-3 pb-1.5">
                <img
                  src={imageSrc}
                  alt={source.name ? `Preview of ${source.name}` : 'Document preview'}
                  className="h-20 w-20 rounded-md object-cover border border-system-gray-200"
                  loading="lazy"
                />
              </div>
            )}

            {/* Metadata chips: entities, tags */}
            {(entities.length > 0 || tags.length > 0) && (
              <div className="px-3 pb-2.5 flex flex-wrap items-center gap-1">
                {entities.map((ent, i) => (
                  <span
                    key={`e-${i}-${ent}`}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-stratosort-accent/10 text-stratosort-accent rounded-md"
                  >
                    <Users className="w-2.5 h-2.5" />
                    {ent}
                  </span>
                ))}
                {tags.map((tag, i) => (
                  <span
                    key={`t-${i}-${tag}`}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-system-gray-100 text-system-gray-600 rounded-md"
                  >
                    <Tag className="w-2.5 h-2.5" />
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Relevance reasoning — why this doc was matched */}
            {source.reasoning && description !== source.reasoning && (
              <div className="mx-3 mb-2.5 flex items-start gap-1.5">
                <Lightbulb className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                <Text as="div" variant="tiny" className="text-system-gray-500 line-clamp-1">
                  {source.reasoning}
                </Text>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

SourceList.propTypes = {
  sources: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      fileId: PropTypes.string,
      name: PropTypes.string,
      path: PropTypes.string,
      snippet: PropTypes.string
    })
  ),
  onOpenSource: PropTypes.func.isRequired
};

const AnswerBlock = React.memo(function AnswerBlock({
  title,
  items,
  showTitle = true,
  sources = [],
  onOpenSource = null
}) {
  const redactPaths = useSelector(selectRedactPaths);

  const sourceById = useMemo(
    () =>
      new Map(
        (sources || []).map((s) => [s.id, s]).filter((pair) => pair[0] != null && pair[0] !== '')
      ),
    [sources]
  );

  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {showTitle ? (
        <Text
          as="div"
          variant="tiny"
          className="font-semibold text-system-gray-500 uppercase tracking-wide"
        >
          {title}
        </Text>
      ) : null}
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={`${title}-${idx}`}>
            <div className="text-sm text-system-gray-800 leading-relaxed">
              <Text as="div" variant="small" className="text-system-gray-800 leading-relaxed">
                <CitationRenderer text={item.text} sources={sources} onOpenSource={onOpenSource} />
              </Text>
            </div>
            {item.citations && item.citations.length > 0 ? (
              <Text
                as="div"
                variant="tiny"
                className="mt-1 flex flex-wrap gap-1 text-system-gray-500"
              >
                {item.citations.map((citation) => {
                  const source = sourceById.get(citation);
                  const label = source?.name ? `${citation} · ${source.name}` : citation;
                  const canOpen = typeof onOpenSource === 'function' && source?.path;
                  const titleText = source?.path
                    ? formatDisplayPath(source.path, { redact: redactPaths, segments: 2 })
                    : citation;

                  return (
                    <Button
                      key={citation}
                      type="button"
                      variant="subtle"
                      size="xs"
                      className="px-2 text-system-gray-600"
                      onClick={() => {
                        if (canOpen) onOpenSource(source);
                      }}
                      title={titleText}
                      disabled={!canOpen}
                    >
                      {label}
                    </Button>
                  );
                })}
              </Text>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

AnswerBlock.propTypes = {
  title: PropTypes.string.isRequired,
  items: PropTypes.arrayOf(
    PropTypes.shape({
      text: PropTypes.string.isRequired,
      citations: PropTypes.arrayOf(PropTypes.string)
    })
  ),
  showTitle: PropTypes.bool,
  sources: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      name: PropTypes.string,
      path: PropTypes.string
    })
  ),
  onOpenSource: PropTypes.func
};

ChatModeToggle.propTypes = {
  value: PropTypes.oneOf(['fast', 'deep']).isRequired,
  onChange: PropTypes.func.isRequired
};

/**
 * One chat bubble. Memoized so the 100ms streaming flush — which replaces
 * only the LAST message object — re-renders only that bubble instead of the
 * whole transcript (older bubbles keep identical props: same message
 * reference, isLast=false, isSending=false, statusMessage='', stable
 * handlers). Per-bubble work like sanitizeAnswerText/getPrimaryAnswerItems
 * is what made full-transcript re-renders show up as long scheduler slices.
 */
const ChatMessage = memo(function ChatMessage({
  message,
  isLast,
  isSending,
  statusMessage,
  onOpenSource,
  onQuickSend,
  onRegenerateLast
}) {
  const isUser = message.role === 'user';
  const isLatestAssistant = !isUser && isLast;
  const hasDocumentAnswer =
    Array.isArray(message.documentAnswer) && message.documentAnswer.length > 0;
  const hasSources = Array.isArray(message.sources) && message.sources.length > 0;
  const primaryAnswerItems = getPrimaryAnswerItems(message);
  const assistantDisplayText = getAssistantDisplayText(message);

  return (
    <div className={`chat-message ${isUser ? 'chat-message-user' : 'chat-message-assistant'}`}>
      <div className="chat-message-meta">
        <Text as="div" variant="tiny" className="chat-message-label">
          {isUser ? 'You' : 'Assistant'}
        </Text>
      </div>
      <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
        {isUser ? (
          <div className="chat-message-text whitespace-pre-wrap">{message.text}</div>
        ) : (
          <div className="space-y-3">
            <div className="chat-message-text whitespace-pre-wrap">
              {assistantDisplayText ? (
                <CitationRenderer
                  text={assistantDisplayText}
                  sources={message.sources}
                  onOpenSource={onOpenSource}
                />
              ) : (
                <>
                  {primaryAnswerItems.length === 0 &&
                    (isSending ? (
                      <div className="space-y-1">
                        <div className="text-system-gray-600 text-sm">
                          {statusMessage || 'Working on your answer...'} <ThinkingDots />
                        </div>
                        {message.isStreaming ? (
                          <>
                            <StreamingAnswerSkeleton />
                            {/*
                              Visually hidden but announced: without
                              this, screen readers get no feedback
                              during the stream (the skeleton is
                              aria-hidden and the thinking dots are
                              decorative). Live region on the outer
                              thread picks this up once.
                            */}
                            <span className="sr-only" role="status">
                              Assistant is responding
                            </span>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      'I could not find an answer in the selected documents.'
                    ))}
                </>
              )}
            </div>
            {/* Contradiction detection */}
            {Array.isArray(message.meta?.contradictions) &&
              message.meta.contradictions.length > 0 && (
                <ContradictionCard
                  contradictions={message.meta.contradictions}
                  sources={message.sources}
                  onOpenSource={onOpenSource}
                />
              )}
            {/* Comparison table for comparison queries */}
            {message.meta?.comparisonIntent && hasDocumentAnswer && (
              <ComparisonTable
                documentAnswer={message.documentAnswer}
                sources={message.sources}
                onOpenSource={onOpenSource}
              />
            )}
            {/* Gap analysis for gap queries */}
            {message.meta?.gapAnalysisIntent && hasSources && (
              <GapAnalysisCard sources={message.sources} onSend={onQuickSend} />
            )}
            {/* Only show the citations detail panel when document answers
                actually have citation links — otherwise the collapsible sections
                just duplicate the main text and add visual noise. */}
            {hasDocumentAnswer &&
              message.documentAnswer.some(
                (item) => item.citations && item.citations.length > 0
              ) && (
                <details className="chat-details">
                  <summary>
                    Cited sources (
                    {new Set(message.documentAnswer.flatMap((item) => item.citations || [])).size})
                  </summary>
                  <div className="chat-details-body">
                    <AnswerBlock
                      title="Citations"
                      items={message.documentAnswer}
                      showTitle={false}
                      sources={message.sources}
                      onOpenSource={onOpenSource}
                    />
                  </div>
                </details>
              )}
            {Array.isArray(message.followUps) && message.followUps.length > 0 ? (
              <div className="space-y-2 pt-1">
                <div className="flex justify-between items-center gap-compact">
                  <Text
                    as="span"
                    variant="tiny"
                    className="font-semibold text-system-gray-500 uppercase tracking-wide"
                  >
                    Try next
                  </Text>
                  {isLast && (
                    <button
                      type="button"
                      className="chat-followup-regenerate"
                      onClick={onRegenerateLast}
                      title="Regenerate response"
                      aria-label="Regenerate response"
                      disabled={isSending}
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      Regenerate
                    </button>
                  )}
                </div>
                <div className="chat-followups">
                  {message.followUps.map((followUp) => (
                    <button
                      key={followUp}
                      type="button"
                      className="chat-followup"
                      onClick={() => {
                        onQuickSend(followUp).catch(() => {
                          // Keep UI stable; errors surface through parent state.
                        });
                      }}
                      disabled={isSending}
                    >
                      <ArrowUpRight className="chat-followup-icon w-4 h-4" aria-hidden="true" />
                      <span>{followUp}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {hasSources ? (
              <details className="chat-details" open={isLatestAssistant || undefined}>
                <summary>Sources ({message.sources.length})</summary>
                <div className="chat-details-body">
                  <SourceList sources={message.sources} onOpenSource={onOpenSource} />
                </div>
              </details>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

ChatMessage.propTypes = {
  message: PropTypes.shape({
    role: PropTypes.oneOf(['user', 'assistant']).isRequired,
    text: PropTypes.string,
    isStreaming: PropTypes.bool,
    documentAnswer: PropTypes.array,
    modelAnswer: PropTypes.array,
    followUps: PropTypes.array,
    sources: PropTypes.array,
    meta: PropTypes.object
  }).isRequired,
  isLast: PropTypes.bool.isRequired,
  isSending: PropTypes.bool.isRequired,
  statusMessage: PropTypes.string,
  onOpenSource: PropTypes.func.isRequired,
  onQuickSend: PropTypes.func.isRequired,
  onRegenerateLast: PropTypes.func.isRequired
};

function ChatPanel({
  messages,
  onSend,
  onRegenerate = null,
  onReset,
  onStopGenerating = () => {},
  isSending,
  statusMessage,
  error = '',
  warning = '',
  useSearchContext,
  onToggleSearchContext,
  searchContextCount = 0,
  strictScope = false,
  onToggleStrictScope = () => {},
  onOpenSource,
  onUseSourcesInGraph,
  showGraphActions = true,
  isSearching,
  isLoadingStats,
  responseMode = 'fast',
  onResponseModeChange = () => {},
  chatPersona = DEFAULT_CHAT_PERSONA_ID,
  onChatPersonaChange = () => {},
  chatPersonaOptions = DEFAULT_PERSONA_OPTIONS,
  disabled = false
}) {
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const threadRef = useRef(null);
  const showSearchStatus = useSearchContext && (isSearching || isLoadingStats);

  // Auto-scroll to bottom when messages change or during streaming,
  // but only if the user is already near the bottom (within 120px).
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isSending, statusMessage]);

  const latestSources = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].sources || [];
    }
    return [];
  }, [messages]);

  const bannerMessage = useMemo(() => {
    const parts = [];
    if (typeof warning === 'string' && warning.trim()) {
      parts.push(warning.trim());
    }
    if (messages.length >= LONG_THREAD_MESSAGE_THRESHOLD) {
      parts.push('This conversation is long; retrieval may be slower and use more memory.');
    }
    return parts.join(' ');
  }, [warning, messages.length]);

  const isLongThread = messages.length >= LONG_THREAD_MESSAGE_THRESHOLD;

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;
    try {
      await onSend(trimmed);
      setInput('');
    } catch {
      // Keep the input so the user can retry on failure
    }
  };

  // Refs mirror fast-changing values so the callbacks below stay
  // referentially stable across streaming flushes — identity churn here
  // would defeat ChatMessage's memo and re-render the whole transcript.
  const messagesRef = useRef(messages);
  const isSendingRef = useRef(isSending);
  useEffect(() => {
    messagesRef.current = messages;
    isSendingRef.current = isSending;
  }, [messages, isSending]);

  const handleQuickSend = useMemo(() => {
    return async (text) => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed || isSendingRef.current) return;
      try {
        await onSend(trimmed);
      } catch {
        // Keep UI stable; errors surface through parent state.
      }
    };
  }, [onSend]);

  const handleRegenerateLast = useMemo(() => {
    return async () => {
      if (isSendingRef.current) return;
      try {
        const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === 'user');
        if (lastUserMsg?.text) {
          if (typeof onRegenerate === 'function') {
            await onRegenerate(lastUserMsg.text);
          } else {
            await handleQuickSend(lastUserMsg.text);
          }
        }
      } catch {
        // Parent state handles surfaced errors.
      }
    };
  }, [onRegenerate, handleQuickSend]);

  const personaOptions =
    Array.isArray(chatPersonaOptions) && chatPersonaOptions.length > 0
      ? chatPersonaOptions
      : DEFAULT_PERSONA_OPTIONS;

  return (
    <div className="flex flex-1 min-h-0 flex-col chat-panel min-w-0">
      <div className="flex items-center justify-between gap-cozy border-b border-system-gray-200 px-4 py-3 min-w-0">
        <Text as="div" variant="small" className="font-semibold text-system-gray-800">
          Conversational chat
        </Text>
        <div className="flex items-center gap-compact">
          {showSearchStatus && (
            <div className="inline-flex items-center gap-compact bg-system-gray-100 px-2 py-1 rounded-full">
              <div className="h-2 w-2 rounded-full bg-system-gray-400 animate-pulse" />
              <Text as="span" variant="tiny" className="text-system-gray-500">
                Updating search context...
              </Text>
            </div>
          )}
          {isSending && (
            <div className="inline-flex items-center gap-compact bg-stratosort-blue/10 px-2 py-1 rounded-full">
              <div className="h-2 w-2 rounded-full bg-stratosort-blue animate-pulse" />
              <Text as="span" variant="tiny" className="text-system-gray-500">
                {statusMessage || 'Assistant thinking'} <ThinkingDots />
              </Text>
            </div>
          )}
          <div className="flex items-center gap-compact shrink-0">
            <Text
              as="span"
              variant="tiny"
              className="font-medium text-system-gray-600 whitespace-nowrap"
            >
              Persona
            </Text>
            <Select
              value={chatPersona}
              onChange={(event) => onChatPersonaChange(event.target.value)}
              className="h-7 text-xs w-40 min-w-[10rem]"
              title="Choose chat persona"
            >
              {personaOptions.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.label}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
            title="Chat settings"
            aria-label="Chat settings"
            className={
              showSettings ? 'bg-system-gray-100 text-stratosort-blue' : 'text-system-gray-500'
            }
          >
            <Settings2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            title="Reset chat"
            aria-label="Reset chat"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {showSettings && (
        <div className="px-4 py-3 bg-system-gray-50/50 border-b border-system-gray-200 flex items-center gap-relaxed flex-wrap animate-slide-down">
          <div className="flex items-center gap-compact shrink-0">
            <Text
              as="span"
              variant="tiny"
              className="font-medium text-system-gray-600 whitespace-nowrap"
            >
              Strict scope
            </Text>
            <Switch
              checked={strictScope}
              onChange={onToggleStrictScope}
              title="Only answer from selected documents"
              aria-label="Toggle strict scope"
            />
          </div>
          <div className="flex items-center gap-compact shrink-0">
            <Text
              as="span"
              variant="tiny"
              className="font-medium text-system-gray-600 whitespace-nowrap"
            >
              Search context
            </Text>
            <Switch
              checked={useSearchContext}
              onChange={onToggleSearchContext}
              aria-label="Toggle search context"
            />
          </div>
          <div className="h-4 w-px bg-system-gray-200 mx-2 hidden sm:block" />
          <ChatModeToggle value={responseMode} onChange={onResponseModeChange} />
        </div>
      )}

      {bannerMessage ? (
        <div className="px-4 pt-3">
          <ChatWarningBanner
            message={bannerMessage}
            action={
              isLongThread && typeof onReset === 'function' ? (
                <Button
                  variant="primary"
                  size="xs"
                  onClick={onReset}
                  disabled={isSending}
                  aria-label="Start a fresh conversation"
                >
                  Start fresh
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}

      <div
        ref={threadRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 chat-thread"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        aria-label="Chat transcript"
      >
        {messages.length === 0 ? (
          <Text variant="small" className="text-system-gray-500">
            Ask me anything about your documents — search by meaning, summarize, or explore
            connections.
          </Text>
        ) : null}

        {messages.map((message, idx) => {
          const isLast = idx === messages.length - 1;
          return (
            <ChatMessage
              key={`${message.role}-${idx}`}
              message={message}
              isLast={isLast}
              // Fast-changing props are pinned to inert values for non-last
              // bubbles so memoization holds during streaming (statusMessage
              // and isSending only ever affect the last bubble's placeholder
              // and its Regenerate/follow-up buttons).
              isSending={isLast ? isSending : false}
              statusMessage={isLast ? statusMessage : ''}
              onOpenSource={onOpenSource}
              onQuickSend={handleQuickSend}
              onRegenerateLast={handleRegenerateLast}
            />
          );
        })}
        {isSending && (!messages.length || messages[messages.length - 1].role !== 'assistant') && (
          <div className="chat-message chat-message-assistant">
            <div className="chat-message-meta">
              <Text as="div" variant="tiny" className="chat-message-label">
                Assistant
              </Text>
            </div>
            <div className="chat-bubble chat-bubble-assistant">
              <div className="chat-message-text text-system-gray-500">
                {statusMessage || 'Assistant is thinking'} <ThinkingDots />
              </div>
            </div>
          </div>
        )}
      </div>

      {error ? (
        <div className="px-4 py-2 border-t border-border-soft flex items-center justify-between gap-cozy bg-stratosort-danger/5">
          <StateMessage
            icon={AlertTriangle}
            tone="error"
            size="sm"
            align="left"
            title="Chat error"
            description={error}
            className="flex-1 min-w-0 p-0"
            contentClassName="max-w-xl"
          />
          {typeof onRegenerate === 'function' && messages.some((m) => m.role === 'user') && (
            <Button
              variant="primary"
              size="sm"
              disabled={isSending}
              onClick={async () => {
                const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
                if (lastUserMsg?.text) {
                  await onRegenerate(lastUserMsg.text);
                }
              }}
              className="shrink-0"
              aria-label="Retry the last chat request"
            >
              Retry
            </Button>
          )}
        </div>
      ) : null}

      <div className="border-t border-system-gray-200 px-4 py-3 chat-input">
        {useSearchContext ? (
          <Text
            as="p"
            variant="tiny"
            className="mb-2 text-system-gray-500"
            data-testid="chat-search-context-scope"
          >
            {searchContextCount > 0
              ? `Answering from your last search: ${searchContextCount} file${searchContextCount === 1 ? '' : 's'}`
              : 'Search context is on: run a search to answer from its results'}
          </Text>
        ) : null}
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            disabled
              ? 'Chat is offline'
              : "Ask a question about your documents (e.g., 'Summarize my tax returns')..."
          }
          disabled={disabled || isSending}
          autoExpand
          rows={2}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-compact">
            <Text as="span" variant="tiny" className="text-system-gray-500">
              Ctrl/⌘ + Enter to send
            </Text>
            {showGraphActions && latestSources.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onUseSourcesInGraph(latestSources)}
                aria-label="View sources in graph"
              >
                View in graph
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-cozy">
            {isSending ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onStopGenerating}
                aria-label="Stop generating"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSend}
              disabled={disabled || isSending || !input.trim()}
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
              <span>Send</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const MemoizedChatPanel = memo(ChatPanel);
MemoizedChatPanel.displayName = 'ChatPanel';
export default MemoizedChatPanel;

ChatPanel.propTypes = {
  messages: PropTypes.arrayOf(
    PropTypes.shape({
      role: PropTypes.oneOf(['user', 'assistant']).isRequired,
      text: PropTypes.string,
      documentAnswer: PropTypes.array,
      modelAnswer: PropTypes.array,
      followUps: PropTypes.array,
      sources: PropTypes.array
    })
  ).isRequired,
  onSend: PropTypes.func.isRequired,
  onRegenerate: PropTypes.func,
  onReset: PropTypes.func.isRequired,
  onStopGenerating: PropTypes.func,
  isSending: PropTypes.bool.isRequired,
  statusMessage: PropTypes.string,
  error: PropTypes.string,
  warning: PropTypes.string,
  useSearchContext: PropTypes.bool.isRequired,
  onToggleSearchContext: PropTypes.func.isRequired,
  searchContextCount: PropTypes.number,
  strictScope: PropTypes.bool,
  onToggleStrictScope: PropTypes.func,
  onOpenSource: PropTypes.func.isRequired,
  onUseSourcesInGraph: PropTypes.func.isRequired,
  showGraphActions: PropTypes.bool,
  isSearching: PropTypes.bool,
  isLoadingStats: PropTypes.bool,
  responseMode: PropTypes.oneOf(['fast', 'deep']),
  onResponseModeChange: PropTypes.func,
  chatPersona: PropTypes.string,
  onChatPersonaChange: PropTypes.func,
  chatPersonaOptions: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired
    })
  ),
  disabled: PropTypes.bool
};
