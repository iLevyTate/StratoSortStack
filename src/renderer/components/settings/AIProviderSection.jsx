import React from 'react';
import PropTypes from 'prop-types';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import SettingsCard from './SettingsCard';
import SettingRow from './SettingRow';
import Button from '../ui/Button';
import Label from '../ui/Label';
import { fetchAiConfig, setRouting, getKeyStatus } from '../../store/slices/aiProviderSlice';
import AIProviderConfigModal from './AIProviderConfigModal';
import CloudAIConsentModal, { hasAcknowledgedCloudAI } from '../common/CloudAIConsentModal';
import {
  AI_CLOUD_ROUTING_SCOPE_DETAIL,
  AI_ROUTED_OPERATIONS,
  describeOperationRouting,
  isCloudProviderId
} from '../../../shared/aiProviderRouting';

const PROVIDER_IDS = ['local', 'anthropic', 'openaiCompatible'];

const PROVIDER_LABELS = {
  local: 'Local Llama',
  anthropic: 'Anthropic Claude',
  openaiCompatible: 'OpenAI / Custom'
};

const DEFAULT_AI_STATE = {
  loaded: false,
  isWorking: false,
  lastError: null,
  settings: {
    providers: { local: { enabled: true } },
    routing: { default: 'local', perOperation: {}, perFolder: {} }
  },
  status: { providers: [] },
  keyStatus: {
    anthropic: { hasKey: false, lastFour: null },
    openaiCompatible: { hasKey: false, lastFour: null }
  }
};

// "document analysis and chat" / "document analysis, chat and organization suggestions"
function formatList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function AIProviderSection({ addNotification }) {
  const dispatch = useAppDispatch();
  const ai = useAppSelector((s) => s.aiProvider || DEFAULT_AI_STATE);
  const aiConfigLoaded = Boolean(ai.loaded);
  const [configuring, setConfiguring] = React.useState(null); // null | 'anthropic' | 'openaiCompatible'
  // The cloud provider named in the consent dialog and the routing change to
  // replay once consent is recorded: { provider, run } or null.
  const [pendingConsent, setPendingConsent] = React.useState(null);
  const initRef = React.useRef(false);

  React.useEffect(() => {
    // StrictMode runs effects twice in dev; refs survive the remount cycle.
    if (initRef.current) return;
    initRef.current = true;

    if (!aiConfigLoaded) {
      dispatch(fetchAiConfig());
    }
    dispatch(getKeyStatus({ provider: 'anthropic' }));
    dispatch(getKeyStatus({ provider: 'openaiCompatible' }));
  }, [dispatch, aiConfigLoaded]);

  const consentAcknowledged = useAppSelector((s) => hasAcknowledgedCloudAI(s));

  const formatError = (err) => {
    if (err?.code === 'CONSENT_REQUIRED' || err?.message === 'CONSENT_REQUIRED') {
      return 'Cloud AI consent is required. Please accept the privacy notice to continue.';
    }
    return err?.message || 'Something went wrong.';
  };

  // Main-process consent gate may reject even though local localStorage said
  // acknowledged (e.g. fresh install with stale flag). Re-prompt the consent
  // modal so the user can recover; a non-cloud change cannot need consent, so
  // that case is reported as an error instead.
  const requestConsentOrReport = (provider, run, err) => {
    if (provider && isCloudProviderId(provider)) {
      setPendingConsent({ provider, run });
      return;
    }
    addNotification?.(formatError(err), 'error');
  };

  const applyDefaultRouting = async (provider) => {
    try {
      await dispatch(setRouting({ default: provider })).unwrap();
      addNotification?.(`Default AI provider set to ${PROVIDER_LABELS[provider]}.`, 'success');
    } catch (err) {
      if (err?.code === 'CONSENT_REQUIRED') {
        requestConsentOrReport(provider, () => applyDefaultRouting(provider), err);
        return;
      }
      addNotification?.(formatError(err), 'error');
    }
  };

  const onChangeDefault = async (provider) => {
    // Gate first cloud-AI activation behind a consent modal. Once acknowledged,
    // subsequent cloud switches apply immediately: the trust statement covers
    // any cloud provider, not a specific one. The consent flag is derived from
    // the persisted main-process settings, falling back to localStorage only
    // before fetchAiConfig completes.
    if (isCloudProviderId(provider) && !consentAcknowledged) {
      setPendingConsent({ provider, run: () => applyDefaultRouting(provider) });
      return;
    }
    await applyDefaultRouting(provider);
  };

  const operationLabel = (operation) =>
    AI_ROUTED_OPERATIONS.find((op) => op.id === operation)?.label || operation;

  // provider null clears the entry so the operation follows the default again.
  const applyOperationRouting = async (operation, provider) => {
    try {
      await dispatch(setRouting({ perOperation: { [operation]: provider } })).unwrap();
      addNotification?.(
        provider
          ? `${operationLabel(operation)} now uses ${PROVIDER_LABELS[provider]}.`
          : `${operationLabel(operation)} follows the default provider again.`,
        'success'
      );
    } catch (err) {
      if (err?.code === 'CONSENT_REQUIRED') {
        requestConsentOrReport(provider, () => applyOperationRouting(operation, provider), err);
        return;
      }
      addNotification?.(formatError(err), 'error');
    }
  };

  const onChangeOperation = async (operation, provider) => {
    if (provider && isCloudProviderId(provider) && !consentAcknowledged) {
      setPendingConsent({ provider, run: () => applyOperationRouting(operation, provider) });
      return;
    }
    await applyOperationRouting(operation, provider);
  };

  const currentDefault = ai.settings?.routing?.default || 'local';
  const perOperation = ai.settings?.routing?.perOperation || {};
  const providers = ai.status?.providers || [];
  const routes = describeOperationRouting(ai.settings, ai.status);
  // Cloud providers some operation points at that are not ready: that work
  // runs on Local Llama until the provider is configured.
  const notReadyByProvider = PROVIDER_IDS.filter(isCloudProviderId)
    .map((providerId) => ({
      providerId,
      labels: routes
        .filter((route) => route.providerId === providerId && !route.ready)
        .map((route) => route.label.toLowerCase())
    }))
    .filter((entry) => entry.labels.length > 0);

  const providerOptionSuffix = (providerId) => {
    if (providerId === 'local') return '';
    const entry = providers.find((p) => p.id === providerId);
    if (!entry || !entry.enabled) return ' (not configured)';
    if (!entry.ready) return ' (not ready)';
    return '';
  };

  return (
    <SettingsCard
      title="AI Provider"
      description="Choose where AI work runs. Local stays on your machine. Cloud is faster but sends file content to the provider you configure."
    >
      <SettingRow layout="col" label="Default provider">
        <div
          role="radiogroup"
          aria-label="Default AI provider"
          className="flex w-full min-w-0 max-w-xl flex-col gap-compact"
        >
          {PROVIDER_IDS.map((p) => {
            const selected = currentDefault === p;
            return (
              <label
                key={p}
                className={`flex w-full min-w-0 cursor-pointer items-center gap-cozy rounded-lg border px-3 py-2.5 transition-colors ${
                  selected
                    ? 'border-stratosort-blue/40 bg-stratosort-blue/5'
                    : 'border-border-soft/60 hover:bg-surface-muted/50'
                }`}
              >
                {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                <input
                  type="radio"
                  name="ai-default-provider"
                  value={p}
                  checked={selected}
                  onChange={() => onChangeDefault(p)}
                  disabled={ai.isWorking}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-system-gray-900">
                    {PROVIDER_LABELS[p]}
                  </span>
                  {p === 'local' && (
                    <span className="block text-xs text-system-gray-500">always available</span>
                  )}
                </span>
                {p !== 'local' && (
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfiguring(p);
                    }}
                  >
                    Configure...
                  </Button>
                )}
              </label>
            );
          })}
        </div>
        <p className="mt-3 w-full min-w-0 text-xs leading-relaxed text-system-gray-500 break-words">
          {AI_CLOUD_ROUTING_SCOPE_DETAIL}
        </p>
        {notReadyByProvider.map(({ providerId, labels }) => (
          <p
            key={providerId}
            role="status"
            className="mt-2 w-full min-w-0 text-xs leading-relaxed text-stratosort-warning break-words"
          >
            {PROVIDER_LABELS[providerId]} is selected for {formatList(labels)} but is not ready, so
            that work runs on Local Llama. For OpenAI, save an API key, enable the provider and set
            a base URL (for example https://api.openai.com/v1), then reopen this panel or restart
            the app.
          </p>
        ))}
      </SettingRow>

      <SettingRow
        layout="col"
        label="Where each kind of work runs"
        description="Leave an operation on Default to follow the provider above, or pick one for it alone. A provider that is not ready falls back to Local Llama for that operation only."
      >
        <div className="flex w-full min-w-0 max-w-xl flex-col gap-cozy">
          {AI_ROUTED_OPERATIONS.map((op) => {
            const selectId = `ai-operation-provider-${op.id}`;
            const helpId = `${selectId}-help`;
            return (
              <div key={op.id} className="flex flex-col gap-1">
                <Label htmlFor={selectId} className="mb-0">
                  {op.label}
                </Label>
                <select
                  id={selectId}
                  value={perOperation[op.id] || ''}
                  onChange={(e) => onChangeOperation(op.id, e.target.value || null)}
                  disabled={ai.isWorking}
                  aria-describedby={helpId}
                  className="form-input-enhanced text-sm py-2"
                >
                  <option value="">Default ({PROVIDER_LABELS[currentDefault]})</option>
                  {PROVIDER_IDS.map((providerId) => {
                    const suffix = providerOptionSuffix(providerId);
                    return (
                      <option key={providerId} value={providerId} disabled={suffix !== ''}>
                        {PROVIDER_LABELS[providerId]}
                        {suffix}
                      </option>
                    );
                  })}
                </select>
                <p id={helpId} className="text-xs leading-snug text-system-gray-500">
                  Sends {op.sends}.
                </p>
              </div>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow layout="col" label="Status">
        <div className="flex w-full min-w-0 flex-wrap gap-1.5">
          {providers.map((p) => {
            const label =
              p.id === 'openaiCompatible'
                ? 'OpenAI'
                : p.id === 'anthropic'
                  ? 'Claude'
                  : p.id === 'local'
                    ? 'Local'
                    : p.id;
            const ok = p.enabled && p.ready;
            return (
              <span
                key={p.id}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none ${
                  ok
                    ? 'border-stratosort-success/40 bg-stratosort-success/10 text-stratosort-success'
                    : 'border-border-soft bg-surface-muted text-system-gray-500'
                }`}
                title={`${p.id}: enabled=${String(p.enabled)}, ready=${String(p.ready)}`}
              >
                {label}
                <span aria-hidden="true">{ok ? '✓' : '—'}</span>
              </span>
            );
          })}
        </div>
      </SettingRow>

      {ai.lastError && (
        <p role="alert" style={{ color: 'var(--color-danger, red)' }}>
          {ai.lastError}
        </p>
      )}

      {configuring && (
        <AIProviderConfigModal
          provider={configuring}
          onClose={() => setConfiguring(null)}
          addNotification={addNotification}
        />
      )}

      {pendingConsent && (
        <CloudAIConsentModal
          provider={pendingConsent.provider}
          onAccept={async () => {
            const { run } = pendingConsent;
            setPendingConsent(null);
            await run();
          }}
          onDecline={() => setPendingConsent(null)}
        />
      )}
    </SettingsCard>
  );
}

AIProviderSection.propTypes = { addNotification: PropTypes.func };
AIProviderSection.defaultProps = { addNotification: undefined };

export default AIProviderSection;
