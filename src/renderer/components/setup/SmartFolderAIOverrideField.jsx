import React from 'react';
import PropTypes from 'prop-types';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { setRouting } from '../../store/slices/aiProviderSlice';
import CloudAIConsentModal, { hasAcknowledgedCloudAI } from '../common/CloudAIConsentModal';
import { AI_CLOUD_ROUTING_SCOPE_SHORT } from '../../../shared/aiProviderRouting';
import Label from '../ui/Label';

const PROVIDER_LABEL_FALLBACK = {
  local: 'Local Llama',
  anthropic: 'Anthropic Claude',
  openaiCompatible: 'OpenAI / Custom'
};

const CLOUD_PROVIDERS = new Set(['anthropic', 'openaiCompatible']);

/**
 * Per-folder routing override field.
 *
 * Each smart folder can override the default AI provider for analyses that
 * happen on files already pinned to it (see `ai.routing.perFolder[folderId]`
 * and `AIRouter.choose`). "App default (Settings)" clears the override.
 *
 * Scope (important): this override fires for **watcher-driven re-analysis**
 * (downloads, file changes, manual re-analyze) and for the MCP `searchDocuments`
 * tool when scoped to this folder. It does NOT fire for **initial drag-drop
 * classification** because the destination folder is the *output* of analysis,
 * not the input — at first-classification time, the system doesn't yet know
 * which folder a file belongs to. **Image analysis** and **embeddings**
 * always stay on-device regardless of this override or the Settings default.
 *
 * Disabled providers stay visible but unselectable — silently allowing a user
 * to pick a provider that isn't configured would create the impression that
 * cloud routing is active when it would actually fall through to local.
 *
 * Cloud overrides require global cloud consent (acknowledgedCloudAt). If the
 * user hasn't accepted yet, picking a cloud provider opens the consent modal;
 * accepting then retries the routing change. Without this, the dropdown would
 * appear to accept the change while the main process silently rejected it.
 */
function SmartFolderAIOverrideField({ folderId }) {
  const dispatch = useAppDispatch();
  const currentOverride = useAppSelector(
    (s) => s.aiProvider?.settings?.routing?.perFolder?.[folderId] || ''
  );
  const providers = useAppSelector((s) => s.aiProvider?.status?.providers || []);
  const consentAcknowledged = useAppSelector((s) => hasAcknowledgedCloudAI(s));
  const [pendingConsent, setPendingConsent] = React.useState(null);
  const [error, setError] = React.useState(null);

  const currentOverrideProvider = currentOverride
    ? providers.find((p) => p.id === currentOverride)
    : null;
  const currentOverrideUnavailable =
    currentOverride &&
    currentOverrideProvider &&
    (!currentOverrideProvider.enabled || !currentOverrideProvider.ready);

  const applyOverride = async (providerOrNull) => {
    setError(null);
    try {
      await dispatch(setRouting({ perFolder: { [folderId]: providerOrNull } })).unwrap();
    } catch (err) {
      if (err?.code === 'CONSENT_REQUIRED') {
        setPendingConsent(providerOrNull);
        return;
      }
      setError(err?.message || 'Could not update folder override.');
    }
  };

  const handleChange = (e) => {
    const next = e.target.value || null;
    // Cloud overrides need global consent. Surface the modal proactively
    // instead of letting the request hit the server and bounce back.
    if (next && CLOUD_PROVIDERS.has(next) && !consentAcknowledged) {
      setPendingConsent(next);
      return;
    }
    void applyOverride(next);
  };

  const selectId = `ai-override-${folderId}`;
  const helpId = `${selectId}-help`;
  const errorId = `${selectId}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={selectId} className="mb-0">
        AI provider
      </Label>
      <select
        id={selectId}
        value={currentOverride}
        onChange={handleChange}
        aria-describedby={error ? `${helpId} ${errorId}` : helpId}
        className="form-input-enhanced text-sm py-2"
      >
        <option value="">App default (Settings)</option>
        {providers.map((p) => {
          const label = p.displayName || PROVIDER_LABEL_FALLBACK[p.id] || p.id;
          const selectable = p.enabled && p.ready;
          return (
            <option key={p.id} value={p.id} disabled={!selectable}>
              {label}
              {!p.enabled ? ' (not configured)' : !p.ready ? ' (not ready)' : ''}
            </option>
          );
        })}
      </select>
      <p id={helpId} className="text-xs leading-snug text-system-gray-500">
        {AI_CLOUD_ROUTING_SCOPE_SHORT}
      </p>
      {currentOverrideUnavailable && (
        <p className="text-xs leading-snug text-stratosort-warning" role="status">
          Saved override is not ready — analysis will use the app default or local model until the
          provider is configured.
        </p>
      )}
      {error && (
        <span id={errorId} role="alert" className="text-xs text-stratosort-danger">
          {error}
        </span>
      )}
      {pendingConsent && (
        <CloudAIConsentModal
          provider={pendingConsent}
          onAccept={async () => {
            const next = pendingConsent;
            setPendingConsent(null);
            await applyOverride(next);
          }}
          onDecline={() => setPendingConsent(null)}
        />
      )}
    </div>
  );
}

SmartFolderAIOverrideField.propTypes = {
  folderId: PropTypes.string.isRequired
};

export default SmartFolderAIOverrideField;
