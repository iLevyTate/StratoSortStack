import React from 'react';
import PropTypes from 'prop-types';
import Select from '../ui/Select';
import Switch from '../ui/Switch';
import AlertBox from '../ui/AlertBox';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';

function EmbeddingBehaviorSection({ settings, setSettings, lockedBySimpleMode = false }) {
  const timing = settings?.embeddingTiming || 'during_analysis';
  const policy = settings?.defaultEmbeddingPolicy || 'embed';
  const scope = settings?.embeddingScope || 'all_analyzed';

  return (
    <SettingsCard
      title="Embedding behavior"
      description="Control when file vectors are stored for search, graph, and similarity. Folder choice (Organize) uses a separate comparison to each Smart Folder's description whenever routing is Auto, Embedding-first, or Hybrid."
    >
      {lockedBySimpleMode && (
        <AlertBox variant="info">
          Embedding timing, default policy, and chunk embeddings are managed automatically in Simple
          mode. Switch to Advanced under Experience level to change them. Editing them here would
          silently revert on save.
        </AlertBox>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-relaxed">
        <SettingRow
          layout="col"
          label="Embedding scope"
          description="Which analyzed files should be stored in the vector index for search. All analyzed (recommended) so inbox files are searchable before they move. Smart folder only waits until a file already lives in a destination."
        >
          <Select
            value={scope}
            onChange={(e) => setSettings((prev) => ({ ...prev, embeddingScope: e.target.value }))}
            className="w-full"
          >
            <option value="all_analyzed">All analyzed files (recommended)</option>
            <option value="smart_folders_only">Smart folder files only</option>
          </Select>
        </SettingRow>

        <SettingRow
          layout="col"
          label="Embedding timing"
          description="When to store the file vector. During analysis (recommended) so Search can use it immediately. After organize still lets Organize compare meaning during analysis; the stored search vector waits until the file is moved. Manual only stores vectors when you rebuild."
        >
          <Select
            value={timing}
            onChange={(e) => setSettings((prev) => ({ ...prev, embeddingTiming: e.target.value }))}
            disabled={lockedBySimpleMode}
            className="w-full"
          >
            <option value="during_analysis">During analysis (recommended)</option>
            <option value="after_organize">After organize/move</option>
            <option value="manual">Manual only</option>
          </Select>
        </SettingRow>

        <SettingRow
          layout="col"
          label="Default embedding policy"
          description="Applies to newly analyzed files. Embed locally (recommended) so Organize, Search, and Atlas share the same meaning index. Skip and web-only do not store local file vectors."
        >
          <Select
            value={policy}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, defaultEmbeddingPolicy: e.target.value }))
            }
            disabled={lockedBySimpleMode}
            className="w-full"
          >
            <option value="embed">Embed locally (recommended)</option>
            <option value="web_only">Web-only (do not embed locally)</option>
            <option value="skip">Skip embedding</option>
          </Select>
        </SettingRow>
      </div>

      <SettingRow
        label="Auto-generate Chunk Embeddings"
        description="Create fine-grained chunk embeddings during file analysis for deeper chat and document retrieval."
      >
        <Switch
          checked={settings?.autoChunkOnAnalysis !== false}
          onChange={(checked) => setSettings((prev) => ({ ...prev, autoChunkOnAnalysis: checked }))}
          disabled={lockedBySimpleMode}
          aria-label="Toggle auto-generate chunk embeddings"
        />
      </SettingRow>
    </SettingsCard>
  );
}

EmbeddingBehaviorSection.propTypes = {
  settings: PropTypes.object,
  setSettings: PropTypes.func.isRequired,
  // True when the panel is in Simple mode but this Advanced-only section was
  // revealed by settings search. The Simple-mode enforced keys
  // (embeddingTiming, defaultEmbeddingPolicy, autoChunkOnAnalysis) are
  // re-applied on every save in that mode, so editing them would silently
  // revert — lock the controls and say why instead.
  lockedBySimpleMode: PropTypes.bool
};

export default EmbeddingBehaviorSection;
