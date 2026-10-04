import React from 'react';
import { createPortal } from 'react-dom';
import PropTypes from 'prop-types';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { useDialogFocusTrap } from '../../hooks';
import { acknowledgeCloud } from '../../store/slices/aiProviderSlice';
import Button from '../ui/Button';
import { Heading } from '../ui/Typography';

export const CLOUD_AI_CONSENT_FLAG = 'stratosort.cloudAI.consentAcknowledged.v1';

const PROVIDER_LABELS = {
  anthropic: 'Anthropic Claude',
  openaiCompatible: 'OpenAI / Custom'
};

// Returns true if the main process has recorded consent. The localStorage
// flag is a fast-path UX hint only — the source of truth lives in the
// persisted AI settings file. Without this, a user who acknowledged in one
// install would have their consent re-blocked on every restart because the
// renderer set localStorage but never told the main process.
export function hasAcknowledgedCloudAI(state) {
  if (state?.aiProvider?.settings?.consent?.acknowledgedCloudAt) return true;
  try {
    // localStorage fallback only useful before fetchAiConfig completes.
    return window.localStorage.getItem(CLOUD_AI_CONSENT_FLAG) === '1';
  } catch {
    return false;
  }
}

function persistLocalAcknowledgment() {
  try {
    window.localStorage.setItem(CLOUD_AI_CONSENT_FLAG, '1');
  } catch {
    // localStorage may be unavailable (private mode quota, etc.). The main
    // process is the source of truth, so this is purely a UX optimization.
  }
}

/**
 * First-run consent dialog shown the first time a user switches the default
 * AI provider away from `local`. Persists consent in BOTH the main process
 * (authoritative, via IPC) and localStorage (fast-path on next render).
 *
 * Design notes:
 *  - Decline does NOT persist the flag — declining means "not now," and
 *    the parent should revert routing.default to `local`.
 *  - Accept persists once and is scoped per-installation. Switching between
 *    different cloud providers later does not re-prompt; the user already
 *    knows the trust model applies to any cloud provider.
 */
function CloudAIConsentModal({ provider, onAccept, onDecline }) {
  const dispatch = useAppDispatch();
  const isWorking = useAppSelector((s) => s.aiProvider?.isWorking);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const providerLabel = PROVIDER_LABELS[provider] || 'the configured cloud provider';

  const dialogRef = React.useRef(null);
  useDialogFocusTrap({
    active: true,
    containerRef: dialogRef,
    // Escape declines ("not now") — but not mid-submit, matching the
    // disabled state of the Keep-local button.
    onEscape: submitting ? undefined : onDecline
  });

  const handleAccept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Authoritative consent lives in the main process. If this rejects we
      // do NOT call onAccept — the user's privacy gate must remain intact.
      await dispatch(acknowledgeCloud()).unwrap();
      persistLocalAcknowledgment();
      onAccept();
    } catch (err) {
      setError(err?.message || 'Could not record consent. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Portal to document.body so we sit above Settings + Configure modals (both
  // z-modal @ body). Rendering inside the Settings tree traps this overlay
  // under the Configure modal portal even with a higher z-index class.
  const content = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cloud-ai-consent-title"
      tabIndex={-1}
      data-testid="cloud-ai-consent-modal"
      className="fixed inset-0 z-modal-consent flex items-center justify-center p-4"
      style={{ zIndex: 'var(--z-modal-consent)', backgroundColor: 'var(--overlay-scrim)' }}
    >
      {/* Tokens only (no dark: variants): the app themes via data-theme, not
          the OS prefers-color-scheme that dark: utilities compile to.
          Scrim/radius/shadow/border mirror the shared Modal panel (U-T7). */}
      <div
        className="rounded-2xl shadow-2xl border border-border-soft max-w-lg w-full p-6"
        style={{ backgroundColor: 'var(--surface-raised)' }}
      >
        {/* Modal-title parity (same recipe as ui/Modal's Heading as="h2"
            variant="h4") — the consent overlay is a Modal-family dialog. */}
        <Heading as="h2" variant="h4" id="cloud-ai-consent-title" className="mb-3">
          Enable cloud AI with {providerLabel}?
        </Heading>

        {/*
          Privacy promise shown on first cloud-AI enable. The structural
          plumbing (Redux thunk, accept/decline wiring, provider naming) is
          locked in by tests — only the prose between the markers below
          should change.
        */}
        {/* --- BEGIN privacy-copy --- */}
        <div className="text-sm text-system-gray-700 space-y-2 mb-5">
          <p>
            With cloud AI on, <strong>{providerLabel}</strong> receives the text of each file when
            it is analyzed, and again on every chat question: the passages, summaries and file paths
            of up to five matching files per question (up to twelve in Deep mode), including text
            read from images by OCR. Organization suggestions send each file&apos;s analysis. Search
            never leaves your machine.
          </p>
          <p>
            This choice covers any cloud provider or OpenAI-compatible endpoint you configure later;
            switching providers will not ask again.
          </p>
          <p>
            Embeddings are always computed locally and never sent to the cloud, and image pixels
            stay here (only their extracted text can travel). Your API key is stored on this device
            using your operating system&apos;s secure key storage where available; if it is
            unavailable, you will be asked to confirm before saving the key unencrypted.
          </p>
          <p>
            Analysis, chat and suggestions can each be kept on Local Llama under Settings → AI
            Provider; only the work you route to the cloud leaves this machine. You can switch back
            to local AI at any time from Settings.
          </p>
        </div>
        {/* --- END privacy-copy --- */}

        {error && (
          <p
            role="alert"
            className="text-sm text-stratosort-danger mb-3"
            data-testid="cloud-ai-consent-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-compact">
          <Button variant="secondary" onClick={onDecline} disabled={submitting}>
            Keep local
          </Button>
          <Button variant="primary" onClick={handleAccept} disabled={submitting || isWorking}>
            {submitting ? 'Recording…' : 'Enable cloud AI'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

CloudAIConsentModal.propTypes = {
  provider: PropTypes.oneOf(['anthropic', 'openaiCompatible']).isRequired,
  onAccept: PropTypes.func.isRequired,
  onDecline: PropTypes.func.isRequired
};

export default CloudAIConsentModal;
