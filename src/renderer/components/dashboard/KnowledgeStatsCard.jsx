import React, { useEffect, useState } from 'react';
import { CalendarRange, Archive, HardDrive, Tags } from 'lucide-react';
import { formatBytes } from '../../utils/format';
import { isIsoDateOnly } from '../../../shared/contentDateSanity';
import Card from '../ui/Card';
import { Text } from '../ui/Typography';

// Mirrors the module-private SectionLabel in DashboardView (importing it back
// would create a cycle: DashboardView -> KnowledgeStatsCard -> DashboardView).
function SectionLabel({ children }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wide text-system-gray-700">
      {children}
    </h2>
  );
}

// Note: AnimatedCount is module-private in DashboardView and not exported.
// Plain numbers are used here intentionally — the card's data is fetched
// async and the count-up animation would conflict with the loading transition.

/**
 * @typedef {{
 *   totalFiles: number,
 *   totalSize: number,
 *   categoriesCount: number,
 *   oldestAnalysis?: string | null,
 *   newestAnalysis?: string | null,
 *   oldestContentDate?: string | null,
 *   newestContentDate?: string | null,
 *   isEmpty: boolean
 * }} KnowledgeStats
 */

/**
 * Derives the year span from ISO date strings.
 * Returns null when the input is falsy or not a valid date string.
 *
 * @param {string | null | undefined} iso
 * @returns {number | null}
 */
function isoToYear(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Same calendar policy as the timeline (timelineRows.js): date-only
  // strings parse as UTC midnight so the UTC year preserves the calendar
  // year, but full analyzed-at timestamps are moments in time and use the
  // LOCAL year — getUTCFullYear on a Dec 31 evening analysis west of UTC
  // showed next-year here while the timeline showed December.
  return isIsoDateOnly(iso) ? d.getUTCFullYear() : d.getFullYear();
}

/**
 * A single stat tile — icon chip + value + label — matching the visual
 * language of PipelineStage in DashboardView (icon in a rounded chip,
 * large mono value, tiny label below).
 *
 * @param {{ icon: React.ElementType, value: string, label: string }} props
 */
function StatTile({ icon: Icon, value, label }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-stratosort-blue/12 text-stratosort-blue">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="mt-2 font-mono text-2xl font-semibold leading-none tracking-tight tabular-nums text-stratosort-blue">
        {value}
      </div>
      <Text variant="tiny" className="mt-1">
        {label}
      </Text>
    </div>
  );
}

/**
 * KnowledgeStatsCard — a "pride-surface" summary of everything the user's
 * local AI has seen. Fetches once on mount via the preload bridge; no Redux
 * dependency (all data comes from analysisHistory, not the file pipeline).
 */
export default function KnowledgeStatsCard() {
  const [stats, setStats] = useState(/** @type {KnowledgeStats | null} */ (null));
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await window.electronAPI?.analysisHistory?.getStatistics?.();
        if (cancelled) return;
        // A non-object response (bridge missing, handler returned nothing)
        // must not strand the card in the loading state.
        if (data && typeof data === 'object') {
          setStats(/** @type {KnowledgeStats} */ (data));
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // API unavailable or thrown
  if (error) {
    return (
      <Card variant="default">
        <SectionLabel>Your knowledge layer</SectionLabel>
        <Text variant="tiny" className="mt-compact block text-system-gray-500" role="alert">
          Knowledge stats unavailable.
        </Text>
      </Card>
    );
  }

  // Loading
  if (stats === null) {
    return (
      <Card variant="default">
        <SectionLabel>Your knowledge layer</SectionLabel>
        <div role="status" className="mt-compact text-micro text-system-gray-500">
          Loading…
        </div>
      </Card>
    );
  }

  // Degraded IPC path: the handler's error fallback is a bare envelope with
  // NO stats fields at all (isEmpty and totalFiles both absent), while
  // genuinely empty stats always carry explicit fields. Rendering the
  // "Analyze files…" invitation to a user whose thousands of analyzed files
  // just failed to load is a lie — show unavailable instead (the degraded
  // banner carries the detail).
  if (stats.isEmpty === undefined && stats.totalFiles === undefined) {
    return (
      <Card variant="default">
        <SectionLabel>Your knowledge layer</SectionLabel>
        <Text variant="tiny" className="mt-compact block text-system-gray-500" role="alert">
          Knowledge stats unavailable.
        </Text>
      </Card>
    );
  }

  // Empty state — explicit zero-entry stats only (see the degraded guard above).
  if (stats.isEmpty || !(Number(stats.totalFiles) > 0)) {
    return (
      <Card variant="default">
        <SectionLabel>Your knowledge layer</SectionLabel>
        <Text variant="small" className="mt-compact block text-system-gray-600">
          Analyze files to build your knowledge layer.
        </Text>
      </Card>
    );
  }

  // Resolve years covered — prefer content dates, fall back to analyzed-at.
  const startYear = isoToYear(stats.oldestContentDate) ?? isoToYear(stats.oldestAnalysis) ?? null;
  const endYear = isoToYear(stats.newestContentDate) ?? isoToYear(stats.newestAnalysis) ?? null;
  const hasYears = startYear !== null && endYear !== null;
  const yearDelta = hasYears ? endYear - startYear : 0;
  const yearLabel =
    yearDelta === 0 ? 'single year' : yearDelta === 1 ? '1 year' : `${yearDelta} years`;

  const tiles = /** @type {Array<{icon: React.ElementType, value: string, label: string}>} */ ([]);

  if (hasYears) {
    tiles.push({
      icon: CalendarRange,
      value: `${startYear} – ${endYear}`,
      label: yearLabel
    });
  }

  tiles.push(
    {
      icon: Archive,
      value: (stats.totalFiles ?? 0).toLocaleString(),
      label: 'items preserved'
    },
    {
      icon: HardDrive,
      value: formatBytes(stats.totalSize ?? 0),
      label: 'storage analyzed'
    },
    {
      icon: Tags,
      value: String(stats.categoriesCount ?? 0),
      label: 'categories'
    }
  );

  return (
    <Card variant="default">
      <SectionLabel>Your knowledge layer</SectionLabel>
      <div
        className={`mt-cozy grid grid-cols-2 gap-cozy ${
          tiles.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'
        }`}
      >
        {tiles.map((tile) => (
          <StatTile key={tile.label} icon={tile.icon} value={tile.value} label={tile.label} />
        ))}
      </div>
    </Card>
  );
}
