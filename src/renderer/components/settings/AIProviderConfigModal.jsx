import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Eye, EyeOff } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Label from '../ui/Label';
import Select from '../ui/Select';
import Switch from '../ui/Switch';
import Modal, { ConfirmModal } from '../ui/Modal';
import { Text } from '../ui/Typography';
import {
  setProviderConfig,
  setProviderKey,
  removeProviderKey,
  testProvider,
  fetchUsage
} from '../../store/slices/aiProviderSlice';
import CloudAIConsentModal, { hasAcknowledgedCloudAI } from '../common/CloudAIConsentModal';

const PROVIDER_LABELS = {
  anthropic: 'Anthropic Claude',
  openaiCompatible: 'OpenAI / Custom'
};

const ANTHROPIC_MODELS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 — best quality (~$15/M tokens)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced (~$3/M tokens)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest (~$0.80/M tokens)' }
];

// Mirrors the Zod ceiling on spendCapMonthlyUsd (ipc/validationSchemas.js).
const SPEND_CAP_MAX_USD = 10000;

function spendCapToInput(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function parseSpendCapInput(raw) {
  if (raw === '') return { ok: true, value: null };
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > SPEND_CAP_MAX_USD) return { ok: false };
  return { ok: true, value: num };
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function defaultModelFor(provider) {
  return provider === 'anthropic' ? 'claude-opus-4-7' : 'gpt-4o';
}

/**
 * The values the form shows for a provider whose stored config may be partial.
 * Shared by the seed effect and the delta check below so "what the field shows
 * when untouched" is defined once — comparing a snapshot against the raw
 * stored object instead would report a phantom edit for every field the
 * settings file simply omits.
 */
function seedConfig({ provider, model, baseUrl, enabled, spendCapMonthlyUsd }) {
  return {
    // Trimmed: surrounding whitespace in a model name or base URL is never
    // meaningful, and leaving it in would make the delta check below treat a
    // stray space as a user edit (turning a plain disable into a consent
    // prompt). A whitespace-only stored value falls back to the default.
    model: String(model ?? '').trim() || defaultModelFor(provider),
    baseUrl: String(baseUrl ?? '').trim() || DEFAULT_OPENAI_BASE_URL,
    enabled: Boolean(enabled),
    spendCap:
      typeof spendCapMonthlyUsd === 'number' && Number.isFinite(spendCapMonthlyUsd)
        ? spendCapMonthlyUsd
        : null
  };
}

/**
 * Which config fields the user actually changed, relative to what is stored.
 *
 * This drives the single cloud-consent exemption: turning a provider off is
 * allowed without consent, but ONLY when that is the whole change. Main
 * accepts a bare `{ enabled: false }` without consent and merges just the
 * keys it is sent (ipc/aiProvider.js SET_PROVIDER_CONFIG), so sending that
 * payload for a form where the model / base URL / cap were also edited
 * discards those edits. The wider payload has to go through the consent
 * prompt — the gate exists so a renderer cannot point baseUrl at an attacker
 * before a key is saved, which is why widening main's exemption is not the fix.
 *
 * Both sides are whitespace-normalized: a trailing space typed into Model or
 * Base URL is not an edit, and must not cost the user a consent prompt.
 */
function changedConfigFields(provider, snapshot, settings) {
  const stored = seedConfig({
    provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    enabled: settings.enabled,
    spendCapMonthlyUsd: settings.spendCapMonthlyUsd
  });
  const changed = [];
  if (snapshot.enabled !== stored.enabled) changed.push('enabled');
  if (String(snapshot.model ?? '').trim() !== stored.model) changed.push('model');
  if (provider === 'openaiCompatible' && String(snapshot.baseUrl ?? '').trim() !== stored.baseUrl) {
    changed.push('baseUrl');
  }
  if (snapshot.spendCap !== stored.spendCap) changed.push('spendCapMonthlyUsd');
  return changed;
}

const COMMON_OPENAI_BASE_URLS = [
  { value: 'https://api.openai.com/v1', label: 'OpenAI (https://api.openai.com/v1)' },
  { value: 'http://localhost:11434/v1', label: 'Ollama (http://localhost:11434/v1)' },
  { value: 'http://localhost:1234/v1', label: 'LM Studio (http://localhost:1234/v1)' },
  { value: 'https://api.groq.com/openai/v1', label: 'Groq' },
  { value: 'https://api.deepseek.com/v1', label: 'DeepSeek' }
];

function AIProviderConfigModal({ provider, onClose, addNotification }) {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s) => s.aiProvider?.settings?.providers?.[provider] || {});
  const keyStatus = useAppSelector(
    (s) => s.aiProvider?.keyStatus?.[provider] || { hasKey: false, lastFour: null }
  );
  const testResult = useAppSelector((s) => s.aiProvider?.testResults?.[provider]);
  const consentAcknowledged = useAppSelector((s) => hasAcknowledgedCloudAI(s));
  const monthUsage = useAppSelector((s) => s.aiProvider?.usage?.thisMonth?.[provider] || null);
  const usageHealth = useAppSelector((s) => s.aiProvider?.usage?.health || null);
  // The tracker refuses every call once it cannot verify spend (a load
  // failure, or three writes in a row lost); before that it keeps counting
  // from memory. Say which, in the words the cap control uses.
  const trackingBlocked = Boolean(
    usageHealth && (usageHealth.loadError || Number(usageHealth.persistFailureCount) >= 3)
  );
  const trackingShaky = Boolean(usageHealth?.degraded) && !trackingBlocked;
  const savedCap = settings.spendCapMonthlyUsd;
  const capReached =
    typeof savedCap === 'number' &&
    savedCap >= 0 &&
    monthUsage !== null &&
    Number(monthUsage.estCostUsd || 0) >= savedCap;

  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(settings.model || defaultModelFor(provider));
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || DEFAULT_OPENAI_BASE_URL);
  const [enabled, setEnabled] = useState(Boolean(settings.enabled));
  const [spendCap, setSpendCap] = useState(spendCapToInput(settings.spendCapMonthlyUsd));
  const [testing, setTesting] = useState(false);
  // True once the user has touched any config field. The Redux resync below
  // must not clobber in-progress edits when a background refresh (e.g. a
  // test-connection fulfillment) updates the provider settings slice.
  const [formDirty, setFormDirty] = useState(false);

  useEffect(() => {
    setFormDirty(false);
  }, [provider]);

  useEffect(() => {
    if (formDirty) return;
    const seed = seedConfig({
      provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      enabled: settings.enabled,
      spendCapMonthlyUsd: settings.spendCapMonthlyUsd
    });
    setModel(seed.model);
    setBaseUrl(seed.baseUrl);
    setEnabled(seed.enabled);
    setSpendCap(spendCapToInput(seed.spendCap));
  }, [
    provider,
    settings.model,
    settings.baseUrl,
    settings.enabled,
    settings.spendCapMonthlyUsd,
    formDirty
  ]);

  // Month-to-date spend sits next to the cap so the number means something.
  useEffect(() => {
    dispatch(fetchUsage());
  }, [dispatch, provider]);
  const [saving, setSaving] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const savingKeyRef = useRef(false);
  // pendingAction: when consent is missing or safeStorage unavailable, we
  // capture the deferred action here so it can replay after the user
  // acknowledges / confirms the prompt.
  const [pendingConsentAction, setPendingConsentAction] = useState(null);
  const [pendingPlaintextKey, setPendingPlaintextKey] = useState(null);
  // Inline remove-confirmation flag. Replaces a bare `window.confirm()` which
  // blocked the renderer thread, returned false silently in test/headless
  // contexts, and could be bypassed by the user closing the modal mid-prompt.
  const [pendingRemove, setPendingRemove] = useState(false);

  const formatError = (err) => {
    if (err?.code === 'CONSENT_REQUIRED' || err?.message === 'CONSENT_REQUIRED') {
      return 'Cloud AI consent is required.';
    }
    if (err?.code === 'ENCRYPTION_UNAVAILABLE') {
      return 'OS-level secret storage is unavailable.';
    }
    return err?.message || 'Something went wrong.';
  };

  const submitKey = async (key, allowPlaintext = false) => {
    await dispatch(setProviderKey({ provider, key, allowPlaintext })).unwrap();
    setKeyInput('');
    addNotification?.(
      allowPlaintext ? 'API key saved (unencrypted — see warning).' : 'API key saved.',
      allowPlaintext ? 'warning' : 'success'
    );
  };

  // Key save that keeps the ENCRYPTION_UNAVAILABLE → plaintext-confirm
  // fallback intact on every path. Used for the consent-deferred retry too:
  // previously a Linux user without a keyring who accepted consent hit a
  // dead-end error toast because the consent onAccept handler didn't route
  // that code to the plaintext prompt.
  const submitKeyWithFallback = async (key) => {
    try {
      await submitKey(key);
    } catch (err) {
      if (err?.code === 'ENCRYPTION_UNAVAILABLE') {
        setPendingPlaintextKey(key);
        return;
      }
      throw err;
    }
  };

  const queueConsentThen = (action) => {
    setPendingConsentAction(() => action);
    addNotification?.('Review the cloud AI consent dialog to continue.', 'info');
  };

  const handleSaveKey = async () => {
    if (savingKeyRef.current) return;
    if (!keyInput) {
      addNotification?.('Enter an API key to save.', 'warning');
      return;
    }
    // Snapshot the key VALUE at click-time. Capturing the live `keyInput`
    // by closure means a retry after the user accepts consent could send
    // a different key than the one they intended (they may have edited
    // the field while the consent modal was open).
    const capturedKey = keyInput;
    savingKeyRef.current = true;
    setSavingKey(true);
    try {
      if (!consentAcknowledged) {
        queueConsentThen(() => submitKeyWithFallback(capturedKey));
        return;
      }
      try {
        await submitKeyWithFallback(capturedKey);
      } catch (err) {
        if (err?.code === 'CONSENT_REQUIRED') {
          queueConsentThen(() => submitKeyWithFallback(capturedKey));
          return;
        }
        addNotification?.(formatError(err), 'error');
      }
    } finally {
      savingKeyRef.current = false;
      setSavingKey(false);
    }
  };

  const handleRemoveKey = useCallback(() => {
    setPendingRemove(true);
  }, []);

  const confirmRemoveKey = useCallback(async () => {
    try {
      await dispatch(removeProviderKey({ provider })).unwrap();
      addNotification?.('API key removed.', 'success');
    } catch (err) {
      addNotification?.(err.message, 'error');
      // Re-throw so ConfirmModal keeps itself open and surfaces the error
      // banner instead of silently closing on a failed remove.
      throw err;
    }
  }, [addNotification, dispatch, provider]);

  const runTest = async () => {
    setTesting(true);
    try {
      const res = await dispatch(testProvider({ provider })).unwrap();
      if (res?.result?.success) {
        addNotification?.(`Connected (${res.result.latencyMs ?? '?'}ms).`, 'success');
      } else {
        addNotification?.(`Test failed: ${res?.result?.error || 'unknown error'}`, 'error');
      }
    } catch (err) {
      addNotification?.(`Test failed: ${formatError(err)}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleTest = async () => {
    if (!consentAcknowledged) {
      queueConsentThen(() => runTest());
      return;
    }
    await runTest();
  };

  // Accepts an explicit snapshot so the retry path doesn't read the live
  // closure scope (which may have changed while the consent modal was open).
  const submitProviderConfig = async (snapshot) => {
    const config = { enabled: snapshot.enabled, model: snapshot.model };
    if (provider === 'openaiCompatible') config.baseUrl = snapshot.baseUrl;
    // null clears the cap on the main side; a number sets it.
    config.spendCapMonthlyUsd = snapshot.spendCap;
    await dispatch(setProviderConfig({ provider, config })).unwrap();
    addNotification?.('Settings saved.', 'success');
    onClose();
  };

  const handleSave = async () => {
    if (saving || pendingConsentAction) return;
    const parsedCap = parseSpendCapInput(spendCap);
    if (!parsedCap.ok) {
      addNotification?.(
        `Monthly spend cap must be a number from 0 to ${SPEND_CAP_MAX_USD}, or empty for no cap.`,
        'error'
      );
      return;
    }
    // Snapshot at click-time so a post-consent retry uses the values the
    // user actually clicked Save with, not whatever they edited afterwards.
    const snapshot = {
      enabled,
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      spendCap: parsedCap.value
    };
    const changedFields = changedConfigFields(provider, snapshot, settings);
    // Edits a bare `{ enabled: false }` write would NOT carry.
    const unsavedEdits = changedFields.filter((f) => f !== 'enabled');
    const turningOff = !snapshot.enabled && changedFields.includes('enabled');
    if (!consentAcknowledged && !snapshot.enabled && (turningOff || unsavedEdits.length === 0)) {
      // Turning a cloud provider OFF must never depend on cloud consent, and
      // must never be undone by the answer to a consent prompt: in a
      // privacy-first product an attempt to switch cloud off may not end with
      // it still on. Main accepts a bare { enabled: false } without consent
      // (ipc/aiProvider.js SET_PROVIDER_CONFIG), so this write always stands
      // on its own; the full form payload would have tripped the gate.
      //
      // We deliberately do NOT route this through the consent prompt even
      // when other fields are dirty. The only dialog we have asks "Enable
      // cloud AI with <provider>?" — the wrong question to put in front of
      // someone switching it off — and declining it used to leave the
      // provider enabled.
      //
      // Entry conditions, both needed:
      //  - `turningOff`: the switch itself moved to off. Honor it whatever
      //    else is dirty.
      //  - `unsavedEdits.length === 0`: nothing but the off switch differs
      //    (including a re-save of an already-off provider, where nothing
      //    differs at all). This is the exemption cb376d47 added.
      // An already-off provider whose model / base URL / cap were edited is
      // neither: there is no disable intent to honor, so those saves fall
      // through to the consent prompt below and replay the whole form rather
      // than losing the edits (F18).
      setSaving(true);
      try {
        await dispatch(setProviderConfig({ provider, config: { enabled: false } })).unwrap();
        if (unsavedEdits.length > 0) {
          // The off switch is stored; the other edits are not, and main will
          // not take them without consent. Say so instead of toasting
          // success, and keep the modal open with the typed values intact —
          // Save again is now a plain config save on an off provider, which
          // offers the consent prompt and stores the whole form.
          addNotification?.(
            'Provider turned off. Your other changes need cloud AI to be acknowledged first — press Save again to store them.',
            'warning'
          );
        } else {
          // Not "Settings saved." — this payload saves the off switch and
          // nothing else, and the user should be told the provider is off
          // rather than left to assume their whole form was stored.
          addNotification?.('Provider turned off.', 'success');
          onClose();
        }
      } catch (err) {
        addNotification?.(formatError(err), 'error');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!consentAcknowledged) {
      queueConsentThen(() => submitProviderConfig(snapshot));
      return;
    }
    setSaving(true);
    try {
      await submitProviderConfig(snapshot);
    } catch (err) {
      if (err?.code === 'CONSENT_REQUIRED') {
        queueConsentThen(() => submitProviderConfig(snapshot));
        return;
      }
      addNotification?.(formatError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Block close while a destructive operation, save, or consent prompt is
  // in flight — silently dropping the modal would orphan the queued action.
  const closeBlocked =
    saving || Boolean(pendingConsentAction) || Boolean(pendingPlaintextKey) || pendingRemove;

  const footer = (
    <div className="flex flex-wrap gap-compact justify-between items-center">
      <Button
        onClick={handleTest}
        variant="ghost"
        size="sm"
        disabled={testing || !keyStatus.hasKey}
      >
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      <div className="flex gap-compact">
        <Button onClick={onClose} variant="secondary" size="sm" disabled={closeBlocked}>
          Cancel
        </Button>
        <Button onClick={handleSave} variant="primary" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Modal
        isOpen
        onClose={closeBlocked ? () => {} : onClose}
        title={`Configure ${PROVIDER_LABELS[provider]}`}
        size="md"
        closeDisabled={closeBlocked}
        closeOnOverlayClick={!closeBlocked}
        closeOnEsc={!closeBlocked}
        footer={footer}
      >
        <div className="flex flex-col gap-default">
          <div>
            <Label htmlFor="ai-provider-key">API key</Label>
            <div className="flex gap-compact">
              <Input
                id="ai-provider-key"
                type={showKey ? 'text' : 'password'}
                placeholder={keyStatus.hasKey ? `Current: •••${keyStatus.lastFour}` : 'sk-…'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                className="flex-1 font-mono"
                aria-label="API key"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                title={showKey ? 'Hide' : 'Show'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </Button>
              <Button variant="primary" size="sm" onClick={handleSaveKey} disabled={savingKey}>
                {savingKey ? 'Saving…' : 'Save key'}
              </Button>
              {keyStatus.hasKey && (
                <Button variant="danger" size="sm" onClick={handleRemoveKey}>
                  Remove
                </Button>
              )}
            </div>
            <Text variant="tiny" className="text-system-gray-500 mt-1.5">
              {provider === 'anthropic'
                ? 'Get a key at console.anthropic.com.'
                : 'Provide an OpenAI-compatible API key. Works with OpenAI, Ollama, LM Studio, Groq, DeepSeek, OpenRouter, etc.'}
            </Text>
          </div>

          {provider === 'openaiCompatible' && (
            <div>
              <Label htmlFor="ai-provider-base-url">Base URL</Label>
              <Input
                id="ai-provider-base-url"
                type="text"
                value={baseUrl}
                onChange={(e) => {
                  setFormDirty(true);
                  setBaseUrl(e.target.value);
                }}
                className="font-mono"
                list="openai-base-urls"
                aria-label="Base URL"
              />
              <datalist id="openai-base-urls">
                {COMMON_OPENAI_BASE_URLS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </datalist>
            </div>
          )}

          <div>
            <Label htmlFor="ai-provider-model">Model</Label>
            {provider === 'anthropic' ? (
              <Select
                id="ai-provider-model"
                value={model}
                onChange={(e) => {
                  setFormDirty(true);
                  setModel(e.target.value);
                }}
                aria-label="Model"
              >
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id="ai-provider-model"
                type="text"
                value={model}
                onChange={(e) => {
                  setFormDirty(true);
                  setModel(e.target.value);
                }}
                placeholder="gpt-4o"
                aria-label="Model"
              />
            )}
          </div>

          <div>
            <Label htmlFor="ai-provider-spend-cap">Monthly spend cap (USD)</Label>
            <Input
              id="ai-provider-spend-cap"
              type="number"
              min="0"
              max={SPEND_CAP_MAX_USD}
              step="1"
              value={spendCap}
              onChange={(e) => {
                setFormDirty(true);
                setSpendCap(e.target.value);
              }}
              placeholder="No cap"
              className="w-40"
              aria-label="Monthly spend cap in USD"
            />
            <Text variant="tiny" className="text-system-gray-500 mt-1.5">
              {monthUsage
                ? `Spent this month: $${Number(monthUsage.estCostUsd || 0).toFixed(2)}, estimated from token counts. `
                : ''}
              Once estimated spend reaches the cap, requests to this provider stop for the rest of
              the month. Document analysis and chat switch to the local model; organization
              suggestions drop the language-model pass and rank folders with embeddings and filename
              patterns instead. Leave empty for no cap. Calls to localhost endpoints count as $0.
            </Text>
            {capReached && (
              <Text variant="tiny" className="text-stratosort-warning mt-1.5" role="status">
                The monthly cap is reached. Requests to this provider are paused until next month
                and that work runs on the local model.
              </Text>
            )}
            {trackingBlocked && (
              <Text variant="tiny" className="text-stratosort-warning mt-1.5" role="status">
                Spend tracking cannot verify this month&apos;s total
                {usageHealth.loadError ? ` (${usageHealth.loadError})` : ''}. Requests to this
                provider are refused until it recovers.
              </Text>
            )}
            {trackingShaky && (
              <Text variant="tiny" className="text-stratosort-warning mt-1.5" role="status">
                Spend tracking could not save its last{' '}
                {Number(usageHealth.persistFailureCount) === 1
                  ? 'update'
                  : `${usageHealth.persistFailureCount} updates`}
                . If this continues, requests to this provider will be refused until it recovers.
              </Text>
            )}
          </div>

          <div className="flex items-center gap-cozy">
            <Switch
              checked={enabled}
              onChange={(value) => {
                setFormDirty(true);
                setEnabled(Boolean(value));
              }}
              aria-label="Enable this provider"
            />
            <span className="text-sm text-system-gray-800">Enable this provider</span>
          </div>

          {testResult && (
            <div
              role="status"
              className={`p-2 rounded text-sm ${
                testResult.ok
                  ? 'bg-stratosort-success/10 text-stratosort-success border border-stratosort-success/20'
                  : 'bg-stratosort-danger/10 text-stratosort-danger border border-stratosort-danger/20'
              }`}
            >
              {testResult.ok
                ? `Connected. Sample response: ${testResult.sample || ''}`
                : `Failed: ${testResult.error || 'Unknown error'}`}
            </div>
          )}
        </div>
      </Modal>

      {pendingConsentAction && (
        <CloudAIConsentModal
          provider={provider}
          onAccept={async () => {
            const fn = pendingConsentAction;
            setPendingConsentAction(null);
            setSaving(true);
            try {
              await fn();
            } catch (err) {
              addNotification?.(formatError(err), 'error');
            } finally {
              setSaving(false);
            }
          }}
          onDecline={() => {
            setPendingConsentAction(null);
            addNotification?.('Cloud AI was not enabled.', 'info');
          }}
        />
      )}

      {pendingPlaintextKey && (
        <PlaintextKeyConfirm
          onAccept={async () => {
            const k = pendingPlaintextKey;
            setPendingPlaintextKey(null);
            try {
              await submitKey(k, true);
            } catch (err) {
              addNotification?.(formatError(err), 'error');
            }
          }}
          onDecline={() => {
            setPendingPlaintextKey(null);
            addNotification?.('Key not saved.', 'info');
          }}
        />
      )}

      <ConfirmModal
        isOpen={pendingRemove}
        onClose={() => setPendingRemove(false)}
        onConfirm={confirmRemoveKey}
        title="Remove saved API key?"
        message="The key will be deleted from this machine's secure storage. You can paste it again later if you change your mind."
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
      />
    </>
  );
}

// Inline confirm dialog for the rare ENCRYPTION_UNAVAILABLE branch (Linux
// without a keyring, headless environments). Kept inline rather than as a
// generic modal because the wording is security-sensitive — we want users
// to see exactly what unprotected storage means before retrying.
function PlaintextKeyConfirm({ onAccept, onDecline }) {
  return (
    <Modal
      isOpen
      onClose={onDecline}
      title="Safe storage is not available on this system"
      size="md"
      variant="destructive"
      footer={
        <>
          <Button onClick={onDecline} variant="secondary" size="sm">
            Cancel
          </Button>
          <Button onClick={onAccept} variant="danger" size="sm">
            Store unprotected
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-cozy">
        <Text variant="body">
          Your operating system did not provide a secure keyring (this is common on Linux without a
          desktop session). The API key would be stored on disk <strong>without encryption</strong>,
          readable by any process running as your user.
        </Text>
        <Text variant="body">
          Continue and store the key unprotected, or cancel and configure a system keyring?
        </Text>
      </div>
    </Modal>
  );
}

PlaintextKeyConfirm.propTypes = {
  onAccept: PropTypes.func.isRequired,
  onDecline: PropTypes.func.isRequired
};

AIProviderConfigModal.propTypes = {
  provider: PropTypes.oneOf(['anthropic', 'openaiCompatible']).isRequired,
  onClose: PropTypes.func.isRequired,
  addNotification: PropTypes.func
};
AIProviderConfigModal.defaultProps = { addNotification: undefined };

export default AIProviderConfigModal;
