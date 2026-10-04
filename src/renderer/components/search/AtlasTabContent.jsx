import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { EmbeddingView } from 'embedding-atlas';
import {
  RefreshCw,
  X,
  AlertTriangle,
  Loader2,
  Search,
  FolderInput,
  Tags,
  FolderPlus
} from 'lucide-react';
import { useAppSelector } from '../../store/hooks';
import { joinPath } from '../../utils/platform';
import { useMoveFilesToFolder } from './hooks/useMoveFilesToFolder';
import {
  pickNextPointInDirection,
  ARROW_DIRECTIONS,
  ATLAS_SEARCH_TOP_K,
  atlasIpcFailureMessage
} from './atlasMapUtils';
import { buildEmbeddingData, nearestPointIndex, indicesInLasso } from './atlasEmbeddingData';

/**
 * Latent-space Atlas: a WebGL/WebGPU scatter plot (Apple embedding-atlas
 * EmbeddingView — CSP-safe, unlike regl which codegens shaders via Function)
 * of every document projected from its embedding to 2D via UMAP (computed +
 * cached in the main process). Position encodes semantic similarity, so
 * clusters and outliers that are invisible in a text list become visible here.
 * Files and folders share the embedding space, so a file sitting far from its
 * folder colour reads as a "probably mis-filed" signal.
 *
 * Beyond viewing, the map is an organizing surface: selecting a file lights up
 * its nearest neighbours, searching dims non-matches in place, and a lasso
 * selection can be moved, tagged, or turned into a smart folder.
 */

const PAGE_LIMIT = 5000;
// Re-poll cadence while the embedding index reports rebuildInProgress — the
// rebuild emits no completion signal of its own, so the tab must ask again.
const REBUILD_POLL_MS = 3000;
const META_BATCH_LIMIT = 100;
const SIMILAR_TOP_K = 10;
const MAX_FOLDER_LABELS = 10;
const MIN_LABEL_MEMBERS = 3;
const SMALL_CORPUS_THRESHOLD = 50;
// querySelection hover radius, in multiples of EmbeddingView's unit distance.
const HOVER_RADIUS_UNITS = 8;

const emptyPoints = () => ({
  ids: [],
  x: [],
  y: [],
  folderKeys: [],
  categoryKeys: [],
  tagKeys: [],
  kinds: [],
  count: 0
});

// Colour-mode buttons: label + the point-field they group by. Category (smart
// folder / AI category) is first and the default because it answers "what is
// this / where does it belong", which the raw source folder does not.
const COLOR_MODES = [
  { mode: 'category', label: 'Category' },
  { mode: 'topics', label: 'Topics' },
  { mode: 'folder', label: 'Source folder' },
  { mode: 'tag', label: 'Tag' },
  { mode: 'kind', label: 'Type' }
];

function AtlasTabContent({ isActive, openFile, revealFile, setError, simpleMode }) {
  const containerRef = useRef(null);
  const viewHostRef = useRef(null);
  const viewRef = useRef(/** @type {any} */ (null));
  const metaCacheRef = useRef(new Map());
  const pointsRef = useRef(/** @type {any} */ (null));
  const drawnPtsRef = useRef(/** @type {any} */ (null));
  const dataRef = useRef(/** @type {any} */ (null));
  const labelsRef = useRef(/** @type {any[]} */ ([]));
  const groupingKeysRef = useRef(/** @type {string[]|null} */ (null));
  const lastViewportRef = useRef(/** @type {any} */ (null));
  const loadGenRef = useRef(0);
  const kbCursorRef = useRef(-1);

  const [status, setStatus] = useState('idle');
  const [points, setPoints] = useState(/** @type {any} */ (null));
  const [meta, setMeta] = useState(/** @type {any} */ (null));
  const [colorMode, setColorMode] = useState('category');
  const [clusterMap, setClusterMap] = useState(/** @type {Map<string,string>|null} */ (null));
  const [isClustering, setIsClustering] = useState(false);
  const [hoverLabel, setHoverLabel] = useState('');
  const [selected, setSelected] = useState(/** @type {number[]} */ ([]));
  const [selectedInfo, setSelectedInfo] = useState(/** @type {any} */ (null));
  const [localError, setLocalError] = useState('');
  const [similar, setSimilar] = useState(/** @type {any} */ (null));
  const [isLoadingSimilar, setIsLoadingSimilar] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchHits, setSearchHits] = useState(/** @type {Set<string>|null} */ (null));
  const [isSearchingMap, setIsSearchingMap] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [isBulkWorking, setIsBulkWorking] = useState(false);
  const [tagDraft, setTagDraft] = useState(/** @type {string|null} */ (null));
  const [folderDraft, setFolderDraft] = useState(/** @type {string|null} */ (null));
  const [smallHintDismissed, setSmallHintDismissed] = useState(false);

  const degradedFlags = useAppSelector((s) => s?.system?.degradedFlags);
  const moveFilesToFolder = useMoveFilesToFolder();

  // Defer the heavy activation work (projection fetch, WebGL EmbeddingView
  // construction and its layout reads) one frame past the tab-switch click.
  // Once armed, stay armed for this mount so switching away from Atlas does
  // not tear down EmbeddingView (avoids re-paying WebGL init + non-passive
  // wheel registration on every return to the tab).
  const [deferredActive, setDeferredActive] = useState(false);
  useEffect(() => {
    if (!isActive || deferredActive) return undefined;
    const raf = requestAnimationFrame(() => setDeferredActive(true));
    return () => cancelAnimationFrame(raf);
  }, [isActive, deferredActive]);

  const setBothErrors = useCallback(
    (msg) => {
      const text = msg || '';
      setLocalError(text);
      if (typeof setError === 'function') setError(text);
    },
    [setError]
  );

  const idIndex = useMemo(() => {
    if (!points) return new Map();
    return new Map(points.ids.map((id, i) => [id, i]));
  }, [points]);

  /** Fetch (and cache) file metadata for a single vector id. */
  const fetchMeta = useCallback(async (id) => {
    if (!id || metaCacheRef.current.has(id)) return metaCacheRef.current.get(id);
    const api = /** @type {any} */ (window).electronAPI?.embeddings;
    if (!api?.getFileMetadata) return null;
    try {
      const res = await api.getFileMetadata([id]);
      const info = res?.metadata?.[id] || null;
      metaCacheRef.current.set(id, info);
      return info;
    } catch {
      return null;
    }
  }, []);

  /** Batched metadata fetch for many vector ids. Returns id -> info map. */
  const fetchMetaBatch = useCallback(async (ids) => {
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      if (metaCacheRef.current.has(id)) out.set(id, metaCacheRef.current.get(id));
      else missing.push(id);
    }
    const api = /** @type {any} */ (window).electronAPI?.embeddings;
    if (!api?.getFileMetadata || missing.length === 0) return out;
    for (let i = 0; i < missing.length; i += META_BATCH_LIMIT) {
      const chunk = missing.slice(i, i + META_BATCH_LIMIT);
      try {
        const res = await api.getFileMetadata(chunk);
        for (const id of chunk) {
          const info = res?.metadata?.[id] || null;
          metaCacheRef.current.set(id, info);
          out.set(id, info);
        }
      } catch {
        /* leave missing ids unresolved */
      }
    }
    return out;
  }, []);

  /** Page through the cached projection until the whole corpus is loaded. */
  const loadProjection = useCallback(
    async (force = false) => {
      const api = /** @type {any} */ (window).electronAPI?.atlas;
      if (!api?.getProjection) {
        setStatus('error');
        setBothErrors('Atlas is unavailable — the projection service did not load.');
        return;
      }
      // Generation token: a newer load (e.g. a forced rebuild racing the
      // initial page-through) abandons this one, so accumulated pages never
      // mix coordinates from two different UMAP fits.
      const gen = ++loadGenRef.current;
      setStatus('loading');
      setBothErrors('');
      metaCacheRef.current.clear();
      setSelected([]);
      kbCursorRef.current = -1;
      // Clear the canvas markers too: the EmbeddingView is not recreated on
      // reload, so stale highlights would otherwise sit over new coordinates.
      try {
        viewRef.current?.update({ selection: null });
      } catch {
        /* a failed update shouldn't block the reload */
      }
      setSimilar(null);
      setSearchHits(null);
      setBulkStatus('');
      setClusterMap(null);
      kbCursorRef.current = -1;
      try {
        let offset = 0;
        let total = 0;
        let metaOut = null;
        let acc = emptyPoints();
        let fitSignature = null;
        let restarts = 0;
        for (let guard = 0; guard < 10000; guard++) {
          const res = await api.getProjection({
            offset,
            limit: PAGE_LIMIT,
            // Only the very first page of the very first attempt forces: a
            // signature-change restart must ADOPT the new fit, not trigger
            // yet another rebuild.
            force: force && offset === 0 && restarts === 0
          });
          if (gen !== loadGenRef.current) return;
          if (!res || res.success === false) {
            throw new Error(atlasIpcFailureMessage(res, 'Atlas'));
          }
          metaOut = res.meta || metaOut;
          if (res.status !== 'ready') {
            setPoints(null);
            setMeta(metaOut);
            setStatus(res.status || 'error');
            return;
          }
          // Each page carries the fit signature it was sliced from. A change
          // mid-pagination means the main-side cache was rebuilt under us
          // (another caller's ensure/force) — accumulated pages would mix two
          // coordinate spaces, so restart the page-through on the new fit.
          const pageSignature = typeof res.signature === 'string' ? res.signature : '';
          if (offset === 0) {
            fitSignature = pageSignature;
          } else if (pageSignature !== fitSignature) {
            restarts += 1;
            if (restarts > 3) {
              throw new Error('Atlas projection kept changing while loading — try again');
            }
            offset = 0;
            total = 0;
            acc = emptyPoints();
            continue;
          }
          total = res.total || 0;
          acc.ids.push(...res.ids);
          acc.x.push(...res.x);
          acc.y.push(...res.y);
          acc.folderKeys.push(...res.folderKeys);
          acc.categoryKeys.push(...(res.categoryKeys || res.folderKeys));
          acc.tagKeys.push(...res.tagKeys);
          acc.kinds.push(...res.kinds);
          offset += res.ids.length;
          if (res.ids.length === 0 || offset >= total) break;
        }
        acc.count = acc.ids.length;
        setPoints(acc);
        setMeta(metaOut);
        setStatus(acc.count > 0 ? 'ready' : 'empty');
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setStatus('error');
        setBothErrors(e?.message || String(e));
      }
    },
    [setBothErrors]
  );

  // Points to visually emphasize: search hits win over neighbour highlight, so
  // clearing a search restores the neighbour view instead of losing it.
  const emphasisSet = useMemo(() => {
    if (searchHits) return searchHits;
    if (similar) return new Set([similar.seedId, ...similar.items.map((it) => it.id)]);
    return null;
  }, [searchHits, similar]);

  // Topics colour mode: lazily cluster the corpus (reusing the shared
  // ClusteringService via IPC) into a fileId -> human label map. Additive — it
  // only reads/recomputes shared clusters; it does not touch the Relate graph.
  useEffect(() => {
    if (colorMode !== 'topics' || clusterMap || !points?.count) return undefined;
    let cancelled = false;
    const api = /** @type {any} */ (window).electronAPI?.embeddings;
    if (!api?.computeClusters) {
      setClusterMap(new Map());
      return undefined;
    }
    setIsClustering(true);
    (async () => {
      try {
        let res = api.getClusters ? await api.getClusters() : null;
        if (
          !res?.success ||
          !Array.isArray(res.clusters) ||
          res.clusters.length === 0 ||
          res.stale
        ) {
          res = await api.computeClusters('auto', { generateLabels: true });
          // computeClusters reports failure as a {success:false, error}
          // envelope, not a throw — unchecked, an unavailable clustering
          // service silently rendered EVERY point as one "(unclustered)"
          // bucket. Route it through the catch so the error surfaces.
          if (res && res.success === false) {
            throw new Error(atlasIpcFailureMessage(res, 'Clustering'));
          }
        }
        if (cancelled) return;
        const map = new Map();
        for (const c of res?.clusters || []) {
          const label = typeof c?.label === 'string' && c.label ? c.label : 'Cluster';
          for (const id of c?.memberIds || []) map.set(id, label);
        }
        setClusterMap(map);
      } catch (e) {
        if (!cancelled) {
          setClusterMap(new Map());
          setBothErrors(e?.message || 'Clustering failed');
        }
      } finally {
        if (!cancelled) setIsClustering(false);
      }
    })();
    return () => {
      cancelled = true;
      // Clear the in-flight spinner on teardown: the guarded `finally` above
      // can't (it's cancelled), so without this the "Grouping…" state sticks
      // if the user leaves Topics before the IPC round-trip resolves.
      setIsClustering(false);
    };
  }, [colorMode, clusterMap, points, setBothErrors]);

  // Drop the cluster map whenever Topics is not the active mode. This lets a
  // failed/too-small clustering attempt retry on re-entry (instead of sticking
  // as a permanent empty map), and — since the fetch above reads getClusters()
  // first — re-entering Topics picks up refined LLM labels computed in the
  // background since last time. getClusters() is a cheap read, so this is not a
  // recompute.
  useEffect(() => {
    if (colorMode !== 'topics') setClusterMap(null);
  }, [colorMode]);

  // Per-point topic labels aligned to points.ids for the 'topics' mode.
  const clusterKeys = useMemo(() => {
    if (!points?.count || !clusterMap) return null;
    return points.ids.map((id) => clusterMap.get(id) || '(unclustered)');
  }, [points, clusterMap]);

  // The key array the active colour mode groups by — also drives orientation
  // labels and tooltips so they read the same buckets as the colours.
  const groupingKeys = useMemo(() => {
    if (!points?.count) return null;
    switch (colorMode) {
      case 'category':
        return points.categoryKeys;
      case 'topics':
        return clusterKeys;
      case 'tag':
        return points.tagKeys;
      // 'folder' and 'kind' both orient by source folder: kind colours by
      // file-vs-folder, but folder names are still the useful map anchors.
      case 'folder':
      case 'kind':
      default:
        return points.folderKeys;
    }
  }, [points, colorMode, clusterKeys]);

  // Inject clusterKeys so buildEmbeddingData/buildCategories can colour topics.
  const pointsForDraw = useMemo(() => {
    if (!points) return points;
    if (colorMode === 'topics') return { ...points, clusterKeys: clusterKeys || [] };
    return points;
  }, [points, colorMode, clusterKeys]);

  // EmbeddingView inputs: typed arrays in data space, categories, and the
  // doubled bright/dim palette that encodes emphasis (no per-point opacity).
  const drawData = useMemo(
    () => buildEmbeddingData(pointsForDraw, colorMode, emphasisSet),
    [pointsForDraw, colorMode, emphasisSet]
  );

  // Orientation labels: the biggest buckets of the active grouping get a
  // floating label anchored to their medoid point (the member closest to the
  // bucket centroid), so labels always sit on an actual cluster.
  const folderLabels = useMemo(() => {
    if (!points?.count || !drawData || !groupingKeys) return [];
    const acc = new Map();
    for (let i = 0; i < points.count; i++) {
      const key = groupingKeys[i];
      if (!key) continue;
      let entry = acc.get(key);
      if (!entry) {
        entry = { sx: 0, sy: 0, n: 0 };
        acc.set(key, entry);
      }
      entry.sx += drawData.pts[i][0];
      entry.sy += drawData.pts[i][1];
      entry.n++;
    }
    const top = [...acc.entries()]
      .filter(([, e]) => e.n >= MIN_LABEL_MEMBERS)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, MAX_FOLDER_LABELS);
    return top.map(([key, e]) => {
      const cx = e.sx / e.n;
      const cy = e.sy / e.n;
      let medoidIdx = -1;
      let best = Infinity;
      for (let i = 0; i < points.count; i++) {
        if (groupingKeys[i] !== key) continue;
        const dx = drawData.pts[i][0] - cx;
        const dy = drawData.pts[i][1] - cy;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          medoidIdx = i;
        }
      }
      return { key, count: e.n, medoidIdx };
    });
  }, [points, drawData, groupingKeys]);

  // Native EmbeddingView labels (data-space coords) — replaces the old
  // camera-synced DOM overlay entirely.
  const viewLabels = useMemo(() => {
    if (!points || !folderLabels.length) return [];
    return folderLabels.map((l) => ({
      x: points.x[l.medoidIdx],
      y: points.y[l.medoidIdx],
      content: l.key
    }));
  }, [points, folderLabels]);

  /**
   * Programmatic selection (keyboard, similar-list clicks, clear buttons):
   * updates React state AND pushes the selection into the view. Canvas-born
   * selections arrive through onSelection/onRangeSelection instead.
   */
  const applySelection = useCallback((indices) => {
    startTransition(() => {
      setSelected(indices);
      kbCursorRef.current = indices.length === 1 ? indices[0] : -1;
      if (indices.length === 0) {
        setSelectedInfo(null);
        setBulkStatus('');
        setTagDraft(null);
        setFolderDraft(null);
      }
    });
    const d = dataRef.current;
    const view = viewRef.current;
    if (!view) return;
    try {
      view.update({
        selection:
          indices.length && d
            ? indices.map((i) => ({ x: d.x[i], y: d.y[i], category: d.category[i], identifier: i }))
            : null,
        ...(indices.length === 0 ? { rangeSelection: null } : {})
      });
    } catch {
      /* a failed update shouldn't crash the tab */
    }
  }, []);

  // Keep refs of points/drawn coords/labels for the view's callbacks and the
  // keyboard handler (which would otherwise close over stale state). Declared
  // BEFORE the creation effect so the refs are fresh on the render where the
  // first projection data arrives and construction fires.
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);
  useEffect(() => {
    drawnPtsRef.current = drawData?.pts || null;
    dataRef.current = drawData;
  }, [drawData]);
  useEffect(() => {
    labelsRef.current = viewLabels;
  }, [viewLabels]);
  useEffect(() => {
    groupingKeysRef.current = groupingKeys;
  }, [groupingKeys]);

  // Create the embedding view once the tab is active AND the first projection
  // data exists. EmbeddingView derives its default viewport (center + scale)
  // from the data it is constructed with — constructing on an empty
  // placeholder locks a degenerate camera that later update({data}) calls do
  // not re-fit, rendering every point off-screen. hasData flips exactly once
  // per projection lifecycle, so the view is still constructed once per
  // activation and the user's viewport survives colour/emphasis updates.
  const hasData = !!drawData;
  useEffect(() => {
    if (!deferredActive || !hasData) return undefined;
    const host = viewHostRef.current;
    const container = containerRef.current;
    if (!host || !container) return undefined;
    const d = dataRef.current;
    if (!d) return undefined;
    const rect = container.getBoundingClientRect();
    // embedding-atlas registers a non-passive wheel listener for zoom
    // (must call preventDefault). That Chromium warning is expected and
    // cannot be silenced without forking the library.
    let view;
    try {
      view = new EmbeddingView(host, {
        data: { x: d.x, y: d.y, category: d.category },
        categoryColors: d.categoryColors,
        labels: labelsRef.current,
        width: rect.width || 800,
        height: rect.height || 600,
        config: { autoLabelEnabled: false, mode: 'points', pointSize: 3 },
        onViewportState: (vs) => {
          lastViewportRef.current = vs;
        },
        onTooltip: async (dp) => {
          const i = dp && Number.isInteger(dp.identifier) ? dp.identifier : -1;
          const p = pointsRef.current;
          if (i < 0 || !p || i >= p.ids.length) {
            setHoverLabel('');
            return;
          }
          const kind = p.kinds[i];
          const rawId = p.ids[i];
          if (kind === 'folder') {
            setHoverLabel(`Folder: ${p.folderKeys[i] || '(unnamed)'}`);
            return;
          }
          // Lead with the active grouping bucket (category/topic/folder/tag) so
          // the tooltip reads meaningfully, then resolve the filename async.
          const gk = groupingKeysRef.current;
          const bucket = gk && typeof gk[i] === 'string' ? gk[i] : '';
          setHoverLabel(bucket || rawId);
          const info = await fetchMeta(rawId);
          if (info?.fileName) {
            setHoverLabel(bucket ? `${bucket} · ${info.fileName}` : info.fileName);
          }
        },
        onSelection: (sel) => {
          const next = Array.isArray(sel)
            ? sel.map((p) => p?.identifier).filter((v) => Number.isInteger(v))
            : [];
          startTransition(() => {
            setSelected(next);
            kbCursorRef.current = next.length === 1 ? next[0] : -1;
            if (next.length === 0) {
              setSelectedInfo(null);
              setBulkStatus('');
              setTagDraft(null);
              setFolderDraft(null);
            }
          });
        },
        onRangeSelection: (range) => {
          const d2 = dataRef.current;
          if (!d2 || !range) return;
          const idx = indicesInLasso(range, d2.x, d2.y);
          applySelection(idx);
        },
        querySelection: async (qx, qy, unitDistance) => {
          const d2 = dataRef.current;
          if (!d2) return null;
          const i = nearestPointIndex(qx, qy, d2.x, d2.y, unitDistance * HOVER_RADIUS_UNITS);
          return i < 0 ? null : { x: d2.x[i], y: d2.y[i], category: d2.category[i], identifier: i };
        }
      });
    } catch (e) {
      setStatus('error');
      setBothErrors(`WebGL init failed: ${e?.message || String(e)}`);
      return undefined;
    }
    viewRef.current = view;

    // Prefer contentRect from ResizeObserver — avoids forced reflow from
    // getBoundingClientRect during layout observation.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry?.contentRect?.width;
      const height = entry?.contentRect?.height;
      // Ignore collapsed/hidden frames so parking the tab off-screen cannot
      // permanently shrink the WebGL viewport.
      if (width >= 32 && height >= 32) view.update({ width, height });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      try {
        view.destroy();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
  }, [deferredActive, hasData, applySelection, fetchMeta, setBothErrors]);

  // Re-measure when returning to the tab (hidden parking can skip tiny RO frames).
  useEffect(() => {
    if (!isActive) return;
    const view = viewRef.current;
    const container = containerRef.current;
    if (!view || !container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width >= 32 && height >= 32) {
      try {
        view.update({ width, height });
      } catch {
        /* ignore */
      }
    }
  }, [isActive]);

  // Load data when the tab becomes active (one frame after the click).
  useEffect(() => {
    if (deferredActive && status === 'idle') loadProjection(false);
  }, [deferredActive, status, loadProjection]);

  // 'rebuilding' is transient (the embedding-index rebuild owns it) but no
  // completion signal is ever pushed, so without a re-poll the overlay's
  // "the map will refresh shortly" promise was a dead end — the state only
  // cleared on tab switch or a needless manual full Rebuild. Each poll
  // flips status rebuilding->loading->..., so the effect re-arms per cycle;
  // the interval also survives a status answer that stays 'rebuilding'.
  // 'empty' is deliberately NOT polled: it changes via analysis activity,
  // which raises its own degraded-flag/organize signals.
  useEffect(() => {
    if (!isActive || status !== 'rebuilding') return undefined;
    const timer = setInterval(() => loadProjection(false), REBUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [isActive, status, loadProjection]);

  // Push data whenever the projection, colour mode, or emphasis changes
  // (emphasis lives in the doubled bright/dim palette).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !drawData) return;
    try {
      view.update({
        data: { x: drawData.x, y: drawData.y, category: drawData.category },
        categoryColors: drawData.categoryColors,
        labels: viewLabels
      });
    } catch {
      /* a failed update shouldn't crash the tab */
    }
  }, [drawData, viewLabels]);

  // A model/dimension change invalidates the projection on the main side; when
  // the corresponding degraded flag appears, force a rebuild so the map matches
  // the new embedding space.
  const embeddingFlagSig = useMemo(() => {
    if (!Array.isArray(degradedFlags)) return '';
    return degradedFlags
      .filter((f) => f?.subsystem === 'vector-db' || String(f?.code || '').includes('embedding'))
      .map((f) => `${f.code}:${f.lastSeenAt || ''}`)
      .join('|');
  }, [degradedFlags]);
  const lastFlagSigRef = useRef(/** @type {string|null} */ (null));
  useEffect(() => {
    if (!deferredActive) return;
    // First active run only records the baseline: the tab unmounts on every
    // tab switch, so treating a pre-existing (possibly long-dismissed) flag
    // as "new" here forced a full UMAP refit on every Atlas activation — and
    // raced the idle-load effect's own loadProjection in the same commit.
    // The mount load is already fresh: the main-side service invalidates its
    // cache on embedding-model-change, so only flags arriving while mounted
    // need a forced rebuild.
    if (lastFlagSigRef.current === null) {
      lastFlagSigRef.current = embeddingFlagSig;
      return;
    }
    if (embeddingFlagSig && embeddingFlagSig !== lastFlagSigRef.current) {
      lastFlagSigRef.current = embeddingFlagSig;
      loadProjection(true);
    }
  }, [deferredActive, embeddingFlagSig, loadProjection]);

  // Resolve details for a single selected file so we can offer open/reveal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (selected.length !== 1 || !points) {
        setSelectedInfo(null);
        return;
      }
      const idx = selected[0];
      if (idx < 0 || idx >= points.ids.length) return;
      if (points.kinds[idx] === 'folder') {
        setSelectedInfo({ kind: 'folder', label: points.folderKeys[idx] });
        return;
      }
      const info = await fetchMeta(points.ids[idx]);
      if (!cancelled) {
        setSelectedInfo({
          kind: 'file',
          label: info?.fileName || points.ids[idx],
          path: info?.path || info?.filePath || ''
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, points, fetchMeta]);

  // Neighbour highlight: a single selected file lights up its nearest
  // neighbours in embedding space and lists them ranked by similarity.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (selected.length !== 1 || !points || points.kinds[selected[0]] !== 'file') {
        setSimilar(null);
        return;
      }
      const seedId = points.ids[selected[0]];
      const api = /** @type {any} */ (window).electronAPI?.embeddings;
      if (!api?.findSimilar) {
        setSimilar(null);
        return;
      }
      setIsLoadingSimilar(true);
      try {
        const resp = await api.findSimilar(seedId, SIMILAR_TOP_K);
        if (cancelled) return;
        if (!resp?.success) {
          setSimilar(null);
          setBothErrors(atlasIpcFailureMessage(resp, 'Similar files'));
          return;
        }
        const raw = (Array.isArray(resp.results) ? resp.results : []).filter(
          (r) => r?.id && r.id !== seedId && idIndex.has(r.id)
        );
        const metaMap = await fetchMetaBatch(raw.map((r) => r.id));
        if (cancelled) return;
        setSimilar({
          seedId,
          items: raw.map((r) => {
            const info = metaMap.get(r.id);
            return {
              id: r.id,
              score: typeof r.score === 'number' ? r.score : 0,
              label: info?.fileName || r.id,
              path: info?.path || info?.filePath || ''
            };
          })
        });
      } catch (e) {
        // Preload safeInvoke can throw (rate limit, timeout); a stale
        // neighbour list must not survive attached to a new selection.
        if (!cancelled) {
          setSimilar(null);
          setBothErrors(atlasIpcFailureMessage(e, 'Similar files'));
        }
      } finally {
        if (!cancelled) setIsLoadingSimilar(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, points, idIndex, fetchMetaBatch, setBothErrors]);

  const runMapSearch = useCallback(async () => {
    const q = searchText.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    const api = /** @type {any} */ (window).electronAPI?.embeddings;
    if (!api?.search) return;
    setIsSearchingMap(true);
    try {
      const resp = await api.search(q, {
        topK: ATLAS_SEARCH_TOP_K,
        mode: 'hybrid',
        rerank: false
      });
      if (!resp?.success) {
        throw new Error(atlasIpcFailureMessage(resp, 'Search'));
      }
      const hits = new Set(
        (Array.isArray(resp.results) ? resp.results : [])
          .map((r) => r?.id)
          .filter((id) => id && idIndex.has(id))
      );
      setSearchHits(hits);
      setBothErrors('');
    } catch (e) {
      setBothErrors(atlasIpcFailureMessage(e, 'Search'));
    } finally {
      setIsSearchingMap(false);
    }
  }, [searchText, idIndex, setBothErrors]);

  const clearMapSearch = useCallback(() => {
    setSearchText('');
    setSearchHits(null);
  }, []);

  const selectedFileIds = useMemo(() => {
    if (!points) return [];
    return selected.filter((i) => points.kinds[i] === 'file').map((i) => points.ids[i]);
  }, [selected, points]);

  const handleBulkMove = useCallback(async () => {
    if (!selectedFileIds.length) return;
    setIsBulkWorking(true);
    setBulkStatus('Resolving file paths…');
    try {
      const metaMap = await fetchMetaBatch(selectedFileIds);
      const paths = selectedFileIds
        .map((id) => {
          const info = metaMap.get(id);
          return info?.path || info?.filePath || '';
        })
        .filter(Boolean);
      if (!paths.length) {
        setBulkStatus('No movable files in this selection.');
        return;
      }
      const { moved, failed, destFolder } = await moveFilesToFolder(paths, {
        onProgress: setBulkStatus
      });
      if (!destFolder) {
        setBulkStatus('');
        return;
      }
      if (moved > 0) {
        setBulkStatus(`Moved ${moved} file(s).`);
        metaCacheRef.current.clear();
        applySelection([]);
        loadProjection(false);
      }
      if (failed > 0) setBothErrors(`Failed to move ${failed} file(s)`);
    } catch (e) {
      setBothErrors(e?.message || String(e));
    } finally {
      setIsBulkWorking(false);
    }
  }, [
    selectedFileIds,
    fetchMetaBatch,
    moveFilesToFolder,
    applySelection,
    loadProjection,
    setBothErrors
  ]);

  const handleBulkTag = useCallback(
    async (e) => {
      e.preventDefault();
      const tags = (tagDraft || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (!tags.length || !selectedFileIds.length) return;
      setIsBulkWorking(true);
      setBulkStatus(`Tagging ${selectedFileIds.length} file(s)…`);
      try {
        const api = /** @type {any} */ (window).electronAPI?.files;
        const res = await api?.addTags?.(selectedFileIds, tags);
        if (!res?.success) {
          throw new Error(atlasIpcFailureMessage(res?.errors?.[0]?.error || res, 'Tags'));
        }
        setBulkStatus(`Tagged ${selectedFileIds.length} file(s).`);
        setTagDraft(null);
        metaCacheRef.current.clear();
      } catch (err) {
        setBothErrors(atlasIpcFailureMessage(err, 'Tags'));
      } finally {
        setIsBulkWorking(false);
      }
    },
    [tagDraft, selectedFileIds, setBothErrors]
  );

  const handleBulkSmartFolder = useCallback(
    async (e) => {
      e.preventDefault();
      const name = (folderDraft || '').trim();
      if (!name || !selectedFileIds.length) return;
      setIsBulkWorking(true);
      try {
        const files = /** @type {any} */ (window).electronAPI?.files;
        const dirResult = await files?.selectDirectory?.({ purpose: 'destination' });
        if (!dirResult?.success || !dirResult?.path) return;
        const res = await /** @type {any} */ (window).electronAPI?.smartFolders?.add?.({
          name,
          path: joinPath(dirResult.path, name),
          description: `Created from an Atlas selection of ${selectedFileIds.length} files`,
          keywords: [],
          category: 'General'
        });
        if (res?.success === false) {
          throw new Error(atlasIpcFailureMessage(res, 'Smart folder'));
        }
        setBulkStatus(`Smart folder "${name}" created.`);
        setFolderDraft(null);
      } catch (err) {
        setBothErrors(atlasIpcFailureMessage(err, 'Smart folder'));
      } finally {
        setIsBulkWorking(false);
      }
    },
    [folderDraft, selectedFileIds, setBothErrors]
  );

  const focusSimilarItem = useCallback(
    (id) => {
      const idx = idIndex.get(id);
      if (idx == null) return;
      applySelection([idx]);
      const d = dataRef.current;
      const view = viewRef.current;
      if (!d || !view) return;
      try {
        view.update({
          viewportState: {
            x: d.x[idx],
            y: d.y[idx],
            scale: lastViewportRef.current?.scale ?? 0.5
          }
        });
      } catch {
        /* a failed update shouldn't crash the tab */
      }
    },
    [idIndex, applySelection]
  );

  // Keyboard access for the WebGL canvas: arrow keys walk to the nearest point
  // in that direction, Enter opens the selected file, Escape clears.
  const handleCanvasKeyDown = useCallback(
    (e) => {
      const tag = String(/** @type {any} */ (e.target)?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
      const pts = drawnPtsRef.current;
      if (!pts || !pts.length) return;

      const dir = ARROW_DIRECTIONS[e.key];
      if (dir) {
        e.preventDefault();
        const from = kbCursorRef.current;
        const next = from < 0 ? 0 : pickNextPointInDirection(pts, from, dir);
        if (next >= 0) {
          applySelection([next]);
        }
        return;
      }
      if (e.key === 'Enter' && selectedInfo?.kind === 'file' && selectedInfo.path) {
        e.preventDefault();
        openFile?.(selectedInfo.path);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        applySelection([]);
      }
    },
    [selectedInfo, openFile, applySelection]
  );

  const legend = drawData?.legend || [];

  return (
    <div className="flex flex-col h-full min-h-[420px]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-compact pb-2">
        <div className="flex items-center gap-1 text-xs">
          <span className="text-system-gray-500">Colour by</span>
          {COLOR_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => setColorMode(mode)}
              aria-pressed={colorMode === mode}
              className={`px-2 py-1 rounded-md ${
                colorMode === mode
                  ? 'bg-stratosort-indigo text-white'
                  : 'bg-system-gray-100 text-system-gray-600 hover:bg-system-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
          {colorMode === 'topics' && isClustering && (
            <span className="text-system-gray-500" role="status">
              Grouping…
            </span>
          )}
        </div>

        {/* Search-on-map: matches glow, everything else dims in place */}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            runMapSearch();
          }}
        >
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-system-gray-400 pointer-events-none"
            />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search the map"
              aria-label="Search the map"
              className="pl-7 pr-2 py-1 text-xs rounded-md bg-system-gray-100 text-system-gray-700 w-44 focus:outline-none focus:ring-2 focus:ring-stratosort-blue/40"
            />
          </div>
          {isSearchingMap && <Loader2 size={13} className="animate-spin text-system-gray-400" />}
          {searchHits && (
            <span className="text-xs text-system-gray-500">
              {searchHits.size} match{searchHits.size === 1 ? '' : 'es'}
            </span>
          )}
          {(searchHits || searchText) && (
            <button
              type="button"
              onClick={clearMapSearch}
              aria-label="Clear map search"
              className="p-1 rounded-md text-system-gray-500 hover:bg-system-gray-100"
            >
              <X size={13} />
            </button>
          )}
        </form>

        <button
          type="button"
          onClick={() => loadProjection(true)}
          disabled={status === 'loading'}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-system-gray-100 text-system-gray-600 hover:bg-system-gray-200 disabled:opacity-50"
          title="Recompute the projection from scratch"
        >
          <RefreshCw size={13} className={status === 'loading' ? 'animate-spin' : ''} />
          Rebuild
        </button>
        {meta ? (
          <span className="text-xs text-system-gray-500">
            {points?.count ?? 0} points · {meta.model || 'unknown'} ({meta.dim || '?'}d)
          </span>
        ) : null}
      </div>

      {/* Plot surface */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- role="application" is the ARIA pattern for canvas map widgets: it tells AT to pass arrow keys through to the widget's own handler, which drives point-to-point traversal here */}
      <div
        ref={containerRef}
        className="relative flex-1 rounded-xl overflow-hidden bg-system-gray-900/95 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/60"
        role="application"
        tabIndex={0}
        aria-label="Document map. Use arrow keys to move between documents, Enter to open the selected file, Escape to clear the selection. The Search tab lists the same documents as text."
        onKeyDown={handleCanvasKeyDown}
      >
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <div ref={viewHostRef} aria-hidden="true" className="absolute inset-0 w-full h-full" />

        {/* Legend */}
        {status === 'ready' && legend.length > 0 && (
          <div className="absolute top-2 left-2 max-w-[45%] flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-black/40 backdrop-blur-sm p-2 text-micro text-white/90">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1 truncate">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                <span className="truncate max-w-[120px]">{l.label}</span>
              </span>
            ))}
          </div>
        )}

        {/* Hover tooltip */}
        {hoverLabel && (
          <div className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md bg-black/70 px-2 py-1 text-xs text-white pointer-events-none">
            {hoverLabel}
          </div>
        )}

        {/* Screen-reader announcement of the current selection */}
        <div aria-live="polite" className="sr-only">
          {selectedInfo?.label || ''}
        </div>

        {/* Selection panel */}
        {selected.length > 0 && (
          <div className="absolute top-2 right-2 rounded-lg bg-white/95 shadow-lg p-2 text-xs max-w-[260px]">
            <div className="flex items-center justify-between gap-compact mb-1">
              <span className="font-medium">{selected.length} selected</span>
              <button
                type="button"
                onClick={() => applySelection([])}
                title="Clear selection"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>

            {selectedInfo?.kind === 'file' && (
              <>
                <div className="truncate text-system-gray-600 mb-1" title={selectedInfo.path}>
                  {selectedInfo.label}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-stratosort-indigo text-white disabled:opacity-50"
                    disabled={!selectedInfo.path}
                    onClick={() => selectedInfo.path && openFile?.(selectedInfo.path)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-system-gray-100 text-system-gray-700 disabled:opacity-50"
                    disabled={!selectedInfo.path}
                    onClick={() => selectedInfo.path && revealFile?.(selectedInfo.path)}
                  >
                    Reveal
                  </button>
                </div>

                {/* Ranked nearest neighbours; clicking one flies to it */}
                <div className="mt-2 pt-1 border-t border-system-gray-200/80">
                  <div className="font-medium text-system-gray-500 mb-1">Similar files</div>
                  {isLoadingSimilar && (
                    <div className="flex items-center gap-1 text-system-gray-400">
                      <Loader2 size={12} className="animate-spin" /> Finding…
                    </div>
                  )}
                  {!isLoadingSimilar && similar && similar.items.length === 0 && (
                    <div className="text-system-gray-400">No similar files found.</div>
                  )}
                  {!isLoadingSimilar && similar && similar.items.length > 0 && (
                    <div className="max-h-44 overflow-y-auto space-y-0.5">
                      {similar.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => focusSimilarItem(item.id)}
                          title={item.path || item.label}
                          className="w-full flex items-center justify-between gap-compact px-1.5 py-1 rounded text-left hover:bg-system-gray-100"
                        >
                          <span className="truncate text-system-gray-700">{item.label}</span>
                          <span className="shrink-0 text-system-gray-400">
                            {Math.round((item.score || 0) * 100)}%
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {selectedInfo?.kind === 'folder' && (
              <div className="truncate text-system-gray-600">Folder: {selectedInfo.label}</div>
            )}

            {/* Bulk actions for lasso selections */}
            {selected.length > 1 && (
              <div className="mt-1 space-y-1.5">
                <div className="text-system-gray-500">
                  {selectedFileIds.length} file{selectedFileIds.length === 1 ? '' : 's'} in
                  selection
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={handleBulkMove}
                    disabled={isBulkWorking || selectedFileIds.length === 0}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-stratosort-indigo text-white disabled:opacity-50"
                  >
                    <FolderInput size={12} /> Move…
                  </button>
                  <button
                    type="button"
                    onClick={() => setTagDraft(tagDraft == null ? '' : null)}
                    disabled={isBulkWorking || selectedFileIds.length === 0}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-system-gray-100 text-system-gray-700 disabled:opacity-50"
                  >
                    <Tags size={12} /> Tag…
                  </button>
                  <button
                    type="button"
                    onClick={() => setFolderDraft(folderDraft == null ? 'Atlas selection' : null)}
                    disabled={isBulkWorking || selectedFileIds.length === 0}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-system-gray-100 text-system-gray-700 disabled:opacity-50"
                  >
                    <FolderPlus size={12} /> Smart folder…
                  </button>
                </div>
                {tagDraft != null && (
                  <form onSubmit={handleBulkTag} className="flex gap-1">
                    <input
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      placeholder="tags, comma separated"
                      aria-label="Tags to apply"
                      className="flex-1 min-w-0 px-1.5 py-1 rounded border border-system-gray-200 focus:outline-none focus:ring-1 focus:ring-stratosort-blue/40"
                    />
                    <button
                      type="submit"
                      disabled={isBulkWorking}
                      className="px-2 py-1 rounded bg-stratosort-indigo text-white disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </form>
                )}
                {folderDraft != null && (
                  <form onSubmit={handleBulkSmartFolder} className="flex gap-1">
                    <input
                      value={folderDraft}
                      onChange={(e) => setFolderDraft(e.target.value)}
                      placeholder="Smart folder name"
                      aria-label="Smart folder name"
                      className="flex-1 min-w-0 px-1.5 py-1 rounded border border-system-gray-200 focus:outline-none focus:ring-1 focus:ring-stratosort-blue/40"
                    />
                    <button
                      type="submit"
                      disabled={isBulkWorking}
                      className="px-2 py-1 rounded bg-stratosort-indigo text-white disabled:opacity-50"
                    >
                      Create…
                    </button>
                  </form>
                )}
                {bulkStatus && <div className="text-system-gray-500">{bulkStatus}</div>}
              </div>
            )}
          </div>
        )}

        {/* Status overlays */}
        {(status === 'loading' || status === 'rebuilding') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-compact text-white/90 bg-black/30">
            <Loader2 className="animate-spin" size={22} />
            <span className="text-sm">
              {status === 'rebuilding'
                ? 'Embeddings are rebuilding — the map will refresh shortly.'
                : 'Projecting your library…'}
            </span>
          </div>
        )}
        {status === 'empty' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-white/80 text-sm text-center px-6">
            No embedded documents yet. Analyze some files, then come back to see their latent-space
            map.
          </div>
        )}
        {status === 'ready' &&
          points?.count > 0 &&
          points.count < SMALL_CORPUS_THRESHOLD &&
          !smallHintDismissed && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-compact rounded-lg bg-black/60 backdrop-blur-sm px-3 py-1.5 text-xs text-white/85">
              <span>The map gets more meaningful as you analyze more files.</span>
              <button
                type="button"
                onClick={() => setSmallHintDismissed(true)}
                aria-label="Dismiss hint"
                className="text-white/60 hover:text-white"
              >
                <X size={13} />
              </button>
            </div>
          )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-compact text-white/90 bg-black/40 px-6 text-center">
            <AlertTriangle size={22} />
            <span className="text-sm">{localError || 'Failed to build the atlas.'}</span>
            <button
              type="button"
              onClick={() => loadProjection(true)}
              className="mt-1 px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 text-sm"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {!simpleMode && (
        <p className="pt-2 text-micro text-system-gray-400">
          Nearby points are semantically similar. Click a file to light up its neighbours,
          shift-drag to lasso-select for bulk moves and tags, or use arrow keys to walk the map. A
          file far from its folder colour may be mis-filed.
        </p>
      )}
    </div>
  );
}

AtlasTabContent.propTypes = {
  isActive: PropTypes.bool,
  openFile: PropTypes.func,
  revealFile: PropTypes.func,
  setError: PropTypes.func,
  simpleMode: PropTypes.bool
};

export default AtlasTabContent;
