import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { Columns, ExternalLink } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';
import CitationRenderer from './CitationRenderer';

/**
 * FIX BUG-006: Extract only the sentences that cite a specific document.
 */
function extractSegmentsForDoc(text, docId) {
  if (!text || !docId) return text || '';
  const sentences = text.split(/(?<=[.!?])\s+/);
  const marker = `[${docId}]`;
  const matching = sentences.filter((s) => s.includes(marker));
  return matching.length > 0 ? matching.join(' ') : text;
}

/**
 * Extracts a simple comparison structure from documentAnswer items.
 * Each item represents one comparison dimension/topic.
 * The LLM is prompted to structure comparison answers per-topic.
 */
function parseComparisonData(documentAnswer, sources) {
  if (!Array.isArray(documentAnswer) || documentAnswer.length === 0) return null;

  // Each documentAnswer item is treated as a comparison row (one topic/dimension).
  // We extract cited documents per row to build the column set.
  const allDocIds = new Set();
  const rows = documentAnswer.map((item, i) => {
    const citations = item.citations || [];
    citations.forEach((c) => allDocIds.add(c));
    return {
      topic: `Point ${i + 1}`,
      text: item.text || '',
      citations
    };
  });

  // Columns are the unique documents cited across all rows
  const columns = [...allDocIds].map((docId) => {
    const source = (sources || []).find((s) => s.id === docId);
    return {
      id: docId,
      name: source?.name || docId,
      source
    };
  });

  return { rows, columns };
}

export default function ComparisonTable({ documentAnswer, sources, onOpenSource }) {
  const comparison = useMemo(
    () => parseComparisonData(documentAnswer, sources),
    [documentAnswer, sources]
  );

  if (!comparison) return null;

  // The component only renders when the user explicitly asked for a comparison
  // (ChatPanel gates it on `message.meta.comparisonIntent`). Returning null on
  // the single-document case left the user staring at nothing after asking
  // "compare X and Y" — they couldn't tell whether the LLM had failed or only
  // found one matching document. Render an explanatory empty-state so the
  // intent is acknowledged and the next action (broaden scope) is obvious.
  if (comparison.columns.length < 2) {
    const onlyDoc = comparison.columns[0];
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-compact">
          <Columns className="w-4 h-4 text-stratosort-blue" />
          <Text
            as="span"
            variant="tiny"
            className="font-semibold text-system-gray-500 uppercase tracking-wide"
          >
            Comparison view
          </Text>
        </div>
        <div className="rounded-lg border border-system-gray-200 bg-system-gray-50 p-3">
          <Text variant="small" className="text-system-gray-600">
            {onlyDoc
              ? `Only one document matched (${onlyDoc.name}). Comparison needs at least two — broaden the scope or try a less specific query.`
              : 'No documents matched. Comparison needs at least two — broaden the scope or try a less specific query.'}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-compact">
        <Columns className="w-4 h-4 text-stratosort-blue" />
        <Text
          as="span"
          variant="tiny"
          className="font-semibold text-system-gray-500 uppercase tracking-wide"
        >
          Comparison view
        </Text>
      </div>

      <div className="overflow-x-auto rounded-lg border border-system-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-system-gray-50 border-b border-system-gray-200">
              <th className="text-left px-3 py-2 text-xs font-semibold text-system-gray-500 uppercase tracking-wide w-24">
                Topic
              </th>
              {comparison.columns.map((col) => (
                <th key={col.id} className="text-left px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Text
                      as="span"
                      variant="tiny"
                      className="font-semibold text-system-gray-700 truncate"
                    >
                      {col.name}
                    </Text>
                    {col.source?.path && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-0.5 text-stratosort-blue"
                        onClick={() => onOpenSource(col.source)}
                        title="Open source"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-system-gray-100">
            {comparison.rows.map((row, i) => {
              // Determine which columns are cited in this row
              const citedInRow = new Set(row.citations);

              return (
                <tr key={i} className="hover:bg-system-gray-50/50">
                  <td className="px-3 py-2 align-top">
                    <Text as="span" variant="tiny" className="font-medium text-system-gray-500">
                      {row.topic}
                    </Text>
                  </td>
                  {comparison.columns.map((col) => {
                    const isCited = citedInRow.has(col.id);
                    return (
                      <td key={col.id} className="px-3 py-2 align-top">
                        {isCited ? (
                          <div className="text-sm text-system-gray-800 leading-relaxed">
                            <CitationRenderer
                              text={extractSegmentsForDoc(row.text, col.id)}
                              sources={sources}
                              onOpenSource={onOpenSource}
                            />
                          </div>
                        ) : (
                          <Text as="span" variant="tiny" className="text-system-gray-300 italic">
                            Not addressed
                          </Text>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

ComparisonTable.propTypes = {
  documentAnswer: PropTypes.arrayOf(
    PropTypes.shape({
      text: PropTypes.string,
      citations: PropTypes.arrayOf(PropTypes.string)
    })
  ),
  sources: PropTypes.array,
  onOpenSource: PropTypes.func.isRequired
};
