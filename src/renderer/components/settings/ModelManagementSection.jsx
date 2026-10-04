import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  Languages,
  Eye,
  Layers,
  Sparkles,
  CheckCircle2,
  Download,
  HardDrive,
  Loader2
} from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Text } from '../ui/Typography';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import { getAllModels, formatSize } from '../../../shared/modelRegistry';

/**
 * Model management section.
 *
 * Surfaces the curated GGUF model catalog (the only models that can be
 * installed) so the feature is self-documenting: users can see what's
 * available, where it comes from, and what's already installed, instead of
 * guessing exact filenames into a blind text field.
 */

const TYPE_SECTIONS = [
  {
    type: 'text',
    label: 'Language models',
    hint: 'Generate file names, summaries, and chat responses.',
    Icon: Languages
  },
  { type: 'vision', label: 'Vision models', hint: 'Analyze and describe images.', Icon: Eye },
  {
    type: 'embedding',
    label: 'Embedding models',
    hint: 'Power semantic search and clustering.',
    Icon: Layers
  }
];

// The catalog is static, so derive the grouped, display-ready shape once.
function deriveSourceRepo(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const resolveIndex = segments.indexOf('resolve');
    const repoSegments = resolveIndex > 0 ? segments.slice(0, resolveIndex) : segments.slice(0, 2);
    const repo = repoSegments.join('/');
    return { host: parsed.hostname, repo: repo || null };
  } catch {
    return { host: null, repo: null };
  }
}

const CATALOG_ENTRIES = Object.entries(getAllModels()).map(([filename, info]) => ({
  filename,
  type: info.type,
  displayName: info.displayName || filename,
  description: info.description || '',
  size: info.size,
  recommended: Boolean(info.recommended),
  source: deriveSourceRepo(info.url)
}));

function ModelCatalogRow({ model, installed, busy, onDownload, Icon, downloadProgress }) {
  // Per-row progress: the parent's `downloadProgress` describes whichever model
  // is currently being pulled. Match on filename so the bar attaches to the
  // exact row a user clicked Download on. Including-match handles the case
  // where the backend reports a companion filename (e.g. mmproj-* for vision
  // models) under the same logical request.
  const isThisRowDownloading =
    !!downloadProgress &&
    !installed &&
    (downloadProgress.modelName === model.filename ||
      downloadProgress.filename === model.filename ||
      (typeof downloadProgress.modelName === 'string' &&
        model.filename.includes(downloadProgress.modelName)));
  const percent = isThisRowDownloading
    ? Math.max(0, Math.min(100, Math.round(downloadProgress.percent || 0)))
    : 0;

  return (
    <li
      className={[
        'group relative flex flex-col gap-cozy rounded-xl border p-3.5 transition-colors duration-150',
        'sm:flex-row sm:items-center sm:gap-default',
        installed
          ? 'border-stratosort-blue/30 bg-stratosort-blue/5'
          : 'border-border-soft/60 bg-system-gray-100/30 hover:border-border-soft hover:bg-system-gray-100/60'
      ].join(' ')}
    >
      <div
        className={[
          'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg',
          installed
            ? 'bg-stratosort-blue/15 text-stratosort-blue'
            : 'bg-system-gray-900/5 text-system-gray-400'
        ].join(' ')}
        aria-hidden="true"
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Text variant="small" className="text-system-gray-900 font-semibold">
            {model.displayName}
          </Text>
          {model.recommended && (
            <span className="inline-flex items-center gap-1 rounded-full bg-stratosort-blue/10 px-2 py-0.5 text-micro font-medium text-stratosort-blue">
              <Sparkles className="h-3 w-3" aria-hidden="true" /> Recommended
            </span>
          )}
          {Number.isFinite(model.size) && (
            <span className="border-border-soft/70 text-system-gray-400 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro font-medium">
              <HardDrive className="h-3 w-3" aria-hidden="true" /> {formatSize(model.size)}
            </span>
          )}
        </div>
        {model.description && (
          <Text variant="tiny" className="text-system-gray-500 mt-1 leading-relaxed">
            {model.description}
          </Text>
        )}
        <Text
          variant="tiny"
          className="text-system-gray-400/80 mt-1 break-all font-mono text-micro"
        >
          {model.filename}
          {model.source?.repo ? ` · ${model.source.host}/${model.source.repo}` : ''}
        </Text>
      </div>

      <div className="flex-shrink-0 sm:self-center">
        {installed ? (
          <span className="border-stratosort-blue/30 bg-stratosort-blue/10 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold text-stratosort-blue">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Installed
          </span>
        ) : isThisRowDownloading ? (
          // Inline progress for the row whose download is in flight. Showing
          // both the percent label and a bar gives the user two simultaneous
          // signals on slow connections where a single number can look stuck
          // for tens of seconds at a time.
          <div
            className="border-border-soft/60 bg-system-gray-100/50 flex w-[10rem] flex-col gap-1.5 rounded-md border px-2.5 py-1.5"
            role="status"
            aria-live="polite"
            aria-label={`Downloading ${model.displayName}: ${percent} percent`}
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-stratosort-blue">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span className="tabular-nums">{percent}%</span>
              <span className="text-system-gray-500 ml-auto text-[10px] font-normal">
                downloading
              </span>
            </div>
            <div
              className="bg-system-gray-200/60 h-1 w-full overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <div
                className="h-full bg-stratosort-blue transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        ) : (
          <Button
            onClick={() => onDownload(model.filename)}
            variant="secondary"
            type="button"
            size="sm"
            isLoading={busy}
            leftIcon={busy ? null : <Download className="h-4 w-4" />}
            title={`Download ${model.displayName}`}
            className="min-w-[7rem] justify-center"
          >
            {busy ? 'Working…' : 'Download'}
          </Button>
        )}
      </div>
    </li>
  );
}

ModelCatalogRow.propTypes = {
  model: PropTypes.shape({
    filename: PropTypes.string.isRequired,
    displayName: PropTypes.string.isRequired,
    description: PropTypes.string,
    size: PropTypes.number,
    recommended: PropTypes.bool,
    source: PropTypes.shape({ host: PropTypes.string, repo: PropTypes.string })
  }).isRequired,
  installed: PropTypes.bool.isRequired,
  busy: PropTypes.bool.isRequired,
  onDownload: PropTypes.func.isRequired,
  Icon: PropTypes.elementType.isRequired,
  downloadProgress: PropTypes.shape({
    modelName: PropTypes.string,
    filename: PropTypes.string,
    percent: PropTypes.number,
    downloadedBytes: PropTypes.number,
    totalBytes: PropTypes.number
  })
};

function ModelManagementSection({
  newModel,
  setNewModel,
  isAddingModel,
  onAddModel,
  installedModels = [],
  downloadProgress = null
}) {
  const installedSet = useMemo(
    () => new Set(installedModels.map((name) => String(name).toLowerCase())),
    [installedModels]
  );

  const groupedCatalog = useMemo(
    () =>
      TYPE_SECTIONS.map((section) => ({
        ...section,
        models: CATALOG_ENTRIES.filter((model) => model.type === section.type)
      })).filter((section) => section.models.length > 0),
    []
  );

  return (
    <SettingsCard
      title="Model management"
      description="Install AI models from the built-in catalog. Models are downloaded from Hugging Face over HTTPS, verified by SHA-256 checksum, and stored locally in the app's data folder — nothing leaves your device."
    >
      <div className="space-y-6">
        {groupedCatalog.map((section) => (
          <div key={section.type}>
            <div className="flex items-center gap-compact">
              <span
                className="bg-system-gray-900/5 text-system-gray-400 flex h-6 w-6 items-center justify-center rounded-md"
                aria-hidden="true"
              >
                <section.Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <Text variant="small" className="text-system-gray-900 font-semibold tracking-tight">
                {section.label}
              </Text>
              <span className="bg-system-gray-900/5 text-system-gray-400 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                {section.models.length}
              </span>
            </div>
            <Text variant="tiny" className="text-system-gray-500 mt-1 leading-relaxed">
              {section.hint}
            </Text>
            <ul className="mt-3 space-y-2">
              {section.models.map((model) => (
                <ModelCatalogRow
                  key={model.filename}
                  model={model}
                  installed={installedSet.has(model.filename.toLowerCase())}
                  busy={isAddingModel}
                  onDownload={onAddModel}
                  Icon={section.Icon}
                  downloadProgress={downloadProgress}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <SettingRow
        layout="col"
        label="Install by exact filename (advanced)"
        description="Only catalog filenames above are supported. Use this if you already know the exact filename to install."
      >
        <div className="settings-input-group">
          <Input
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            placeholder="e.g. Qwen2.5-7B-Instruct-Q4_K_M.gguf"
            className="w-full"
            aria-label="GGUF model filename to add"
          />
          <Button
            onClick={() => onAddModel()}
            variant="secondary"
            type="button"
            disabled={isAddingModel || !newModel.trim()}
            title="Download model"
            size="sm"
            className="w-full sm:w-auto justify-center min-w-[9rem]"
          >
            {isAddingModel ? 'Adding…' : 'Add model'}
          </Button>
        </div>
      </SettingRow>
    </SettingsCard>
  );
}

ModelManagementSection.propTypes = {
  newModel: PropTypes.string.isRequired,
  setNewModel: PropTypes.func.isRequired,
  isAddingModel: PropTypes.bool.isRequired,
  onAddModel: PropTypes.func.isRequired,
  installedModels: PropTypes.arrayOf(PropTypes.string),
  downloadProgress: PropTypes.shape({
    modelName: PropTypes.string,
    filename: PropTypes.string,
    percent: PropTypes.number,
    downloadedBytes: PropTypes.number,
    totalBytes: PropTypes.number
  })
};

export default ModelManagementSection;
