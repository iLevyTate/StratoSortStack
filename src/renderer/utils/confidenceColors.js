// @ts-check
/**
 * Confidence Color Constants
 *
 * Shared styling constants for confidence levels in the UI.
 * Used by ClusterNode, ClusterLegend, and other visualization components.
 */

import { THRESHOLDS } from '../../shared/performanceConstants';
import { DEFAULT_SETTINGS } from '../../shared/defaultSettings';

export const CONFIDENCE_COLORS = {
  high: {
    bg: 'bg-stratosort-success/10',
    text: 'text-stratosort-success',
    border: 'border-stratosort-success/30',
    dot: '●',
    dotBg: 'bg-stratosort-success',
    label: 'high',
    desc: 'Strong match',
    combined: 'bg-stratosort-success/10 text-stratosort-success border-stratosort-success/30'
  },
  medium: {
    bg: 'bg-stratosort-blue/10',
    text: 'text-stratosort-blue',
    border: 'border-stratosort-blue/30',
    dot: '◐',
    dotBg: 'bg-stratosort-blue',
    label: 'medium',
    desc: 'Partial match',
    combined: 'bg-stratosort-blue/10 text-stratosort-blue border-stratosort-blue/30'
  },
  low: {
    bg: 'bg-system-gray-100',
    text: 'text-system-gray-600',
    border: 'border-system-gray-200',
    dot: '○',
    dotBg: 'bg-system-gray-400',
    label: 'low',
    desc: 'Fallback',
    combined: 'bg-system-gray-100 text-system-gray-600 border-system-gray-200'
  }
};

/**
 * Get color classes for a confidence level
 * @param {string} level - 'high', 'medium', or 'low'
 * @returns {string} Tailwind CSS classes
 */
export function getConfidenceColor(level) {
  const key = ['high', 'medium', 'low'].includes(level) ? level : 'low';
  return /** @type {Record<string, any>} */ (CONFIDENCE_COLORS)[key].combined;
}

/**
 * A folder match score in words, for review cards and the sample run.
 *
 * A bare percentage read as an accuracy rate: a reviewer saw 43% and 64% and
 * judged the whole sort "a 70 to 80% match". The words follow what the app
 * does with the score: at the auto-organize default a file would be moved on
 * its own; at the routing bar a file is sent to a folder by its content;
 * below it a folder was chosen by type or name and is worth a look. The
 * percentage stays available as a tooltip.
 *
 * @param {number|null|undefined} percent - match score, 0..100
 * @returns {{ label: string, level: 'high' | 'medium' | 'low', title: string } | null}
 */
export function describeMatchStrength(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const score = Math.max(0, Math.min(100, Math.round(percent)));
  const title = `Match score ${score}%`;
  if (score >= Math.round(DEFAULT_SETTINGS.confidenceThreshold * 100)) {
    return { label: 'Strong match', level: 'high', title };
  }
  if (score >= Math.round(THRESHOLDS.FOLDER_MATCH_CONFIDENCE * 100)) {
    return { label: 'Good match', level: 'medium', title };
  }
  return { label: 'Check this', level: 'low', title };
}
