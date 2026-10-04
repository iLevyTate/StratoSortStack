import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Rocket,
  FolderOpen,
  Settings,
  Search,
  Sparkles,
  FolderCheck,
  CheckCircle2,
  ListChecks,
  LayoutGrid,
  ArrowRight
} from 'lucide-react';
import { PHASES, AI_DEFAULTS } from '../../shared/constants';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { selectSmartFolders } from '../store/selectors';
import { openSettings, setPhase, setViewMode } from '../store/slices/uiSlice';
import { useNotification } from '../contexts/NotificationContext';
import { Button, Card } from '../components/ui';
import { Heading, Text, Caption } from '../components/ui/Typography';
import Modal from '../components/ui/Modal';
import { Stack } from '../components/layout';
import ModelSetupWizard from '../components/ModelSetupWizard';
import { isForceModelWizardEnabled } from '../utils/debugFlags';

const MODEL_CHECK_ESCAPE_MS = 8000;

/**
 * Persist the user's model auto-download consent decision so it survives
 * restarts. `true` = "Continue with limited AI" (background setup must not
 * download models); `false` = downloads allowed again (set when the user
 * explicitly starts a download in the ModelSetupWizard, or completes it).
 * Best-effort: the in-session UI state still reflects the choice when the
 * settings bridge is unavailable (e.g. tests, degraded preload).
 */
async function persistModelAutoDownloadSkipped(skipped) {
  const update = window?.electronAPI?.settings?.update;
  if (typeof update !== 'function') return;
  try {
    await update('modelAutoDownloadSkipped', skipped);
  } catch {
    // Non-fatal: worst case the background downloader re-offers next launch.
  }
}

/**
 * The catch-all folder: `category: 'uncategorized'` on the canonical one, or
 * named Uncategorized.
 * @param {{ category?: string, name?: string }} folder
 */
function isUncategorizedBucket(folder) {
  const category = typeof folder?.category === 'string' ? folder.category.toLowerCase() : '';
  const name = typeof folder?.name === 'string' ? folder.name.trim().toLowerCase() : '';
  return category === 'uncategorized' || name === 'uncategorized';
}

function WelcomePhase() {
  const dispatch = useAppDispatch();
  const { addNotification } = useNotification();
  const smartFolders = useAppSelector(selectSmartFolders);
  // Any real destination counts; only the Uncategorized bucket does not,
  // because that is where everything lands when there is nothing else (the
  // failure this guards against). Checking `!isDefault` instead also rejected
  // the seven folders "Reset to Defaults" creates (all isDefault), so those
  // users were sent back to Setup on every click.
  const hasSmartFolders = Array.isArray(smartFolders)
    ? smartFolders.some((folder) => folder && !isUncategorizedBucket(folder))
    : false;
  const [showFlowsModal, setShowFlowsModal] = useState(false);
  const [showModelSetupWizard, setShowModelSetupWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState('checking');
  // 'skipped' = user chose "Continue with limited AI": hides the setup card
  // like 'ready' does, but without falsely claiming models were verified.
  // The choice is also persisted as the `modelAutoDownloadSkipped` setting so
  // it survives restarts and gates main-process background model downloads.
  const [modelCheckState, setModelCheckState] = useState('loading'); // 'loading' | 'missing' | 'ready' | 'downloading' | 'skipped'
  const modelCheckLockedRef = useRef(false);
  const autoOpenedWizardRef = useRef(false);
  const [showLoadingEscape, setShowLoadingEscape] = useState(false);

  // Check if required AI models are downloaded
  // Retry once after delay when models list is empty - LlamaService may not be ready yet
  useEffect(() => {
    let cancelled = false;
    const RETRY_DELAY_MS = 1800;
    const forceModelWizard = isForceModelWizardEnabled();
    modelCheckLockedRef.current = false;
    autoOpenedWizardRef.current = false;

    function setModelCheckStateIfAllowed(nextState) {
      if (!cancelled && !modelCheckLockedRef.current) {
        setModelCheckState(nextState);
      }
    }

    function autoOpenModelSetupIfAllowed() {
      if (!cancelled && !modelCheckLockedRef.current && !autoOpenedWizardRef.current) {
        autoOpenedWizardRef.current = true;
        setShowModelSetupWizard(true);
      }
    }

    if (forceModelWizard) {
      setModelCheckStateIfAllowed('missing');
      autoOpenModelSetupIfAllowed();
      return () => {
        cancelled = true;
      };
    }

    async function getActiveMissingDownloadCount(missingModelNames = []) {
      const getStatus = window?.electronAPI?.llama?.getDownloadStatus;
      if (typeof getStatus !== 'function') return 0;
      try {
        const response = await getStatus();
        const downloads = Array.isArray(response?.status?.downloads)
          ? response.status.downloads
          : [];
        if (!Array.isArray(missingModelNames) || missingModelNames.length === 0) {
          return downloads.length;
        }
        const missing = new Set(missingModelNames);
        return downloads.filter((entry) => missing.has(entry?.filename)).length;
      } catch {
        // Download status is best-effort and should not mask missing model state.
        return 0;
      }
    }

    async function doCheck() {
      const getModels = window?.electronAPI?.llama?.getModels;
      const getConfig = window?.electronAPI?.llama?.getConfig;
      const getSettings = window?.electronAPI?.settings?.get;
      if (typeof getModels !== 'function') {
        setModelCheckStateIfAllowed('ready');
        return;
      }
      const modelCheckSettled = await Promise.allSettled([
        getModels(),
        typeof getConfig === 'function' ? getConfig() : Promise.resolve(null),
        typeof getSettings === 'function' ? getSettings() : Promise.resolve(null)
      ]);
      if (modelCheckSettled[0].status === 'rejected') {
        throw modelCheckSettled[0].reason || new Error('Failed to load model list');
      }
      const modelsResponse =
        modelCheckSettled[0].status === 'fulfilled' ? modelCheckSettled[0].value : null;
      const configResponse =
        modelCheckSettled[1].status === 'fulfilled' ? modelCheckSettled[1].value : null;
      // Persisted first-run consent: the user already chose "Continue with
      // limited AI" in a previous session. Honor it — surface the quiet
      // `skipped` state instead of the missing-models card and never auto-open
      // the wizard again. Model setup stays reachable via "AI & model settings".
      const settingsResponse =
        modelCheckSettled[2].status === 'fulfilled' ? modelCheckSettled[2].value : null;
      const persistedSkip = settingsResponse?.modelAutoDownloadSkipped === true;
      if (cancelled) return;

      const modelNames = Array.isArray(modelsResponse?.models)
        ? modelsResponse.models
        : Array.isArray(modelsResponse)
          ? modelsResponse.map((m) => m.name || m.filename || '')
          : [];
      const available = new Set(modelNames.map((n) => String(n)));

      const config = configResponse?.config || configResponse;
      const selectedModels = modelsResponse?.selected || {};
      const required = [
        selectedModels?.embeddingModel || config?.embeddingModel || AI_DEFAULTS?.EMBEDDING?.MODEL,
        selectedModels?.textModel || config?.textModel || AI_DEFAULTS?.TEXT?.MODEL
      ].filter(Boolean);
      const missing = required.filter((name) => !available.has(name));

      if (missing.length === 0) {
        setModelCheckStateIfAllowed('ready');
        return;
      }

      // When required models are missing but available is empty, retry once
      // (LlamaService/filesystem may still be initializing)
      if (available.size === 0 && missing.length > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        if (cancelled) return;
        const retryResponse = await getModels();
        if (cancelled) return;
        const retryNames = Array.isArray(retryResponse?.models)
          ? retryResponse.models
          : Array.isArray(retryResponse)
            ? retryResponse.map((m) => m.name || m.filename || '')
            : [];
        const retryAvailable = new Set(retryNames.map((n) => String(n)));
        const retryMissing = required.filter((name) => !retryAvailable.has(name));
        if (retryMissing.length > 0) {
          if (persistedSkip) {
            setModelCheckStateIfAllowed('skipped');
          } else {
            const activeCount = await getActiveMissingDownloadCount(retryMissing);
            const nextState = activeCount > 0 ? 'downloading' : 'missing';
            setModelCheckStateIfAllowed(nextState);
            autoOpenModelSetupIfAllowed();
          }
        } else {
          setModelCheckStateIfAllowed('ready');
        }
        if (retryResponse?.requiresModelConfirmation) {
          addNotification(
            'Some saved AI model names are outdated. Review model selections in Settings.',
            'warning',
            6000,
            'model-corrections'
          );
        }
        return;
      }

      if (missing.length > 0) {
        if (persistedSkip) {
          setModelCheckStateIfAllowed('skipped');
        } else {
          const activeCount = await getActiveMissingDownloadCount(missing);
          const nextState = activeCount > 0 ? 'downloading' : 'missing';
          setModelCheckStateIfAllowed(nextState);
          autoOpenModelSetupIfAllowed();
        }
      } else {
        setModelCheckStateIfAllowed('ready');
      }
      if (modelsResponse?.requiresModelConfirmation) {
        addNotification(
          'Some saved AI model names are outdated. Review model selections in Settings.',
          'warning',
          6000,
          'model-corrections'
        );
      }
    }

    async function checkModels() {
      try {
        await doCheck();
      } catch {
        setModelCheckStateIfAllowed('missing');
        autoOpenModelSetupIfAllowed();
      }
    }
    checkModels();
    return () => {
      cancelled = true;
    };
  }, [addNotification]);

  const handleModelSetupComplete = useCallback(() => {
    modelCheckLockedRef.current = true;
    setShowModelSetupWizard(false);
    setWizardStep('checking');
    setModelCheckState('ready');
    // Models landed via the wizard — make sure a stale skip decision doesn't
    // keep suppressing background repair downloads on future launches.
    void persistModelAutoDownloadSkipped(false);
    addNotification('AI models are ready. You can start organizing files.', 'success');
  }, [addNotification]);

  const handleModelSetupSkip = useCallback(() => {
    modelCheckLockedRef.current = true;
    setShowModelSetupWizard(false);
    setWizardStep('checking');
    setModelCheckState('skipped');
    // Persist the decision so background setup honors it on every future
    // launch (no multi-GB auto-downloads) until the user explicitly starts a
    // download from the ModelSetupWizard.
    void persistModelAutoDownloadSkipped(true);
    addNotification(
      'Continuing with limited AI. You can download models later from Settings.',
      'info'
    );
  }, [addNotification]);

  // Mirrors the wizard's internal step for modal chrome decisions, and treats
  // an explicit download start as consent: it clears the persisted skip so
  // background setup may resume core-model provisioning on later launches.
  const handleWizardStepChange = useCallback((step) => {
    setWizardStep(step);
    if (step === 'downloading') {
      void persistModelAutoDownloadSkipped(false);
    }
  }, []);

  const handleOpenModelSetup = useCallback(() => {
    modelCheckLockedRef.current = true;
    setWizardStep('checking');
    setShowModelSetupWizard(true);
    addNotification('Opening model setup. You can continue with limited AI at any time.', 'info');
  }, [addNotification]);

  useEffect(() => {
    if (modelCheckState !== 'loading') {
      setShowLoadingEscape(false);
      return undefined;
    }

    const timer = setTimeout(() => {
      setShowLoadingEscape(true);
    }, MODEL_CHECK_ESCAPE_MS);

    return () => clearTimeout(timer);
  }, [modelCheckState]);

  // Passive model-setup states (background download, or a probe that's taking
  // unusually long) surface as transient toasts rather than an in-flow card, so
  // they never reflow the welcome layout. `loading` only toasts once it's slow
  // (showLoadingEscape) to avoid a flash on every normal startup. The groupKey
  // dedupes so re-renders can't stack duplicates. The actionable `missing` state
  // is intentionally excluded here — it keeps its own in-context prompt below.
  useEffect(() => {
    if (modelCheckState === 'downloading') {
      addNotification(
        'AI models are downloading in the background. You can start organizing now.',
        'info',
        6000,
        'models-downloading'
      );
    } else if (modelCheckState === 'loading' && showLoadingEscape) {
      addNotification(
        'Still preparing local AI in the background. You can start organizing now.',
        'info',
        6000,
        'models-loading-slow'
      );
    }
  }, [modelCheckState, showLoadingEscape, addNotification]);

  useEffect(() => {
    if (window.__STRATOSORT_STATE_EXPIRED__) {
      const ageHours = window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__ || 24;
      addNotification(
        `Previous session (${ageHours}h old) was cleared to ensure fresh data. Your files are safe.`,
        'info'
      );
      // Clear flag so notification doesn't repeat
      delete window.__STRATOSORT_STATE_EXPIRED__;
      delete window.__STRATOSORT_STATE_EXPIRED_AGE_HOURS__;
    }
  }, [addNotification]);

  const actions = {
    advancePhase: (phase) => dispatch(setPhase(phase))
  };

  // First-run working-style choice. We only record the preference and enter the
  // flow — choosing Dashboard does NOT jump straight to it, because the dashboard
  // is empty (and its actions are dead ends) until at least one smart folder
  // exists. So dashboard-pickers start in Setup; App.js auto-swaps to the
  // dashboard once a folder lands. Guided-pickers begin at Discover as usual.
  const chooseMode = useCallback(
    (mode) => {
      dispatch(setViewMode(mode));
      dispatch(
        setPhase(
          mode === 'dashboard' ? (PHASES?.SETUP ?? 'setup') : (PHASES?.DISCOVER ?? 'discover')
        )
      );
    },
    [dispatch]
  );

  const flowSteps = [
    {
      icon: FolderOpen,
      title: 'Setup',
      copy: 'Choose the folders StratoSort is allowed to organize into (it only moves files after your review).'
    },
    {
      icon: Search,
      title: 'Discover',
      copy: 'Add files or folders and let local AI understand them.'
    },
    {
      icon: FolderCheck,
      title: 'Organize',
      copy: 'Review suggestions, rename where needed, and stay in control.'
    },
    {
      icon: CheckCircle2,
      title: 'Complete',
      copy: 'See what changed and start the next batch with confidence.'
    }
  ];

  return (
    <div
      className="flex flex-col flex-1 min-h-0 overflow-y-auto modern-scrollbar relative"
      data-testid="phase-welcome-content"
    >
      {/* Centers vertically when the content fits; min-h-full lets it grow
          top-aligned and scroll when it doesn't, so nothing is ever clipped
          into an unreachable region (the old overflow-hidden + justify-center
          hid the bottom of the page on short windows). */}
      <div className="flex min-h-full flex-col justify-center gap-default lg:gap-relaxed max-w-3xl mx-auto w-full px-6 py-4">
        {/* Header first so the hero card stays the visual anchor */}
        <header className="text-center space-y-3">
          <Heading as="h1" variant="display" id="welcome-heading" className="leading-tight">
            <Rocket
              className="inline-block text-stratosort-blue w-9 h-9 md:w-10 md:h-10 mr-3 align-middle"
              aria-label="rocket"
            />
            Welcome to <span className="text-gradient">StratoSort</span>
          </Heading>
          <Text variant="lead" className="max-w-lg mx-auto text-system-gray-600">
            Review, rename, and organize files with local AI.
          </Text>
          <Caption className="text-system-gray-500">
            Private · On-device · You review before any file moves
          </Caption>
        </header>

        {/* Only the actionable `missing` state renders an in-context card — it
            needs the setup buttons, which a string-only toast can't carry, and an
            onboarding decision shouldn't auto-dismiss. The passive loading/
            downloading states go through transient notifications (effect above)
            instead. Even this card is position:absolute (anchored to the welcome
            root) so it floats in the bottom corner rather than reflowing the
            centered column — a full-width banner on small screens. */}
        {modelCheckState === 'missing' && (
          <Card
            variant="compact"
            className="absolute inset-x-4 bottom-4 z-20 shadow-xl border border-stratosort-blue/20 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/10 sm:inset-x-auto sm:right-4 sm:w-[22rem]"
            role="status"
            aria-live="polite"
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-cozy sm:gap-default">
              <div className="flex justify-center sm:justify-start flex-shrink-0">
                <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-stratosort-blue/10">
                  <Sparkles className="w-5 h-5 text-stratosort-blue" aria-hidden />
                </div>
              </div>
              <Stack gap="cozy" className="flex-1 min-w-0 text-center sm:text-left">
                <Heading as="h2" variant="h6" className="text-balance">
                  Finish local AI setup when you are ready
                </Heading>
                <Text variant="small" className="text-system-gray-600 text-balance">
                  You can use the app now; open model setup when you want full AI features.
                </Text>
                <Text variant="tiny" className="text-system-gray-500">
                  Everything stays on this device. You review before any file moves.
                </Text>
              </Stack>
            </div>
            <div className="flex flex-col sm:flex-row gap-compact justify-center sm:justify-end pt-3 mt-3 border-t border-border-soft/80">
              <Button onClick={handleModelSetupSkip} variant="secondary" size="sm">
                Continue with limited AI
              </Button>
              <Button onClick={handleOpenModelSetup} variant="primary" size="sm">
                Open model setup
              </Button>
            </div>
          </Card>
        )}

        {/* Primary Actions Card */}
        <Card variant="hero" role="navigation" aria-label="Primary actions">
          <Stack gap="default">
            {/* Primary Action - Organize */}
            <div className="flex flex-col gap-cozy items-center pb-4 border-b border-border-soft">
              <Button
                onClick={() => {
                  // F-206 (CP-21): with no smart folders every file would land in
                  // Uncategorized, so Setup has to come first.
                  if (!hasSmartFolders) {
                    addNotification(
                      'Add at least one smart folder first so files have somewhere to go.',
                      'info',
                      5000,
                      'organize-needs-folders'
                    );
                    actions.advancePhase(PHASES?.SETUP ?? 'setup');
                    return;
                  }
                  actions.advancePhase(PHASES?.DISCOVER ?? 'discover');
                }}
                variant="primary"
                size="lg"
                className="w-full max-w-md justify-center"
                aria-describedby="organize-help"
              >
                <FolderOpen className="w-5 h-5" />
                Organize files now
              </Button>
              <Text variant="small" className="text-center" id="organize-help">
                Recommended for a first session
              </Text>
            </div>

            {/* Secondary Actions Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
              {/* Tertiary Action - AI / Model settings */}
              <div className="flex flex-col gap-compact">
                <Button
                  onClick={() => dispatch(openSettings())}
                  variant="secondary"
                  className="w-full justify-center h-full py-4"
                  aria-describedby="ai-setup-help"
                >
                  <Sparkles className="w-4 h-4 text-stratosort-accent" />
                  AI &amp; model settings
                </Button>
                <Text variant="tiny" className="text-center" id="ai-setup-help">
                  Tune local models and preferences
                </Text>
              </div>

              {/* Secondary Action - Configure */}
              <div className="flex flex-col gap-compact">
                <Button
                  onClick={() => actions.advancePhase(PHASES?.SETUP ?? 'setup')}
                  variant="secondary"
                  className="w-full justify-center h-full py-4"
                  aria-describedby="setup-help"
                >
                  <Settings className="w-4 h-4" />
                  Configure smart folders
                </Button>
                <Text variant="tiny" className="text-center" id="setup-help">
                  Choose where reviewed files should go
                </Text>
              </div>
            </div>
          </Stack>
        </Card>

        {/* Working-style chooser. Guided is the default path (it matches the hero
            CTA above); the Dashboard card is the discoverable opt-in. You can
            switch anytime later via the toggle in the top navigation bar. */}
        <section aria-labelledby="working-style-heading" className="space-y-3">
          <div className="text-center">
            <Caption id="working-style-heading" className="text-system-gray-500">
              Prefer a different starting point?
            </Caption>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
            <Card
              as="button"
              type="button"
              variant="interactive"
              onClick={() => chooseMode('phased')}
              className="text-left w-full focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <div className="flex items-start gap-cozy">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stratosort-blue/10 text-stratosort-blue">
                  <ListChecks className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <Text
                    as="span"
                    variant="small"
                    className="block font-semibold text-system-gray-900"
                  >
                    Guided steps
                  </Text>
                  <Text as="span" variant="tiny" className="block">
                    Walk through Setup, Discover, and Organize one step at a time.
                  </Text>
                </span>
                <ArrowRight
                  className="ml-auto mt-1 h-4 w-4 shrink-0 text-system-gray-400"
                  aria-hidden="true"
                />
              </div>
            </Card>
            <Card
              as="button"
              type="button"
              variant="interactive"
              onClick={() => chooseMode('dashboard')}
              className="text-left w-full focus-visible:ring-2 focus-visible:ring-stratosort-blue focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <div className="flex items-start gap-cozy">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stratosort-blue/10 text-stratosort-blue">
                  <LayoutGrid className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <Text
                    as="span"
                    variant="small"
                    className="block font-semibold text-system-gray-900"
                  >
                    Dashboard
                  </Text>
                  <Text as="span" variant="tiny" className="block">
                    A single overview screen. We&apos;ll set up your folders first.
                  </Text>
                </span>
                <ArrowRight
                  className="ml-auto mt-1 h-4 w-4 shrink-0 text-system-gray-400"
                  aria-hidden="true"
                />
              </div>
            </Card>
          </div>
        </section>

        <div className="text-center">
          <Button onClick={() => setShowFlowsModal(true)} variant="ghost" size="sm">
            See the full workflow
          </Button>
        </div>
      </div>

      {/* Model Setup Wizard Modal
          - Focus trap, aria-modal, and Escape handling come from the shared Modal.
          - Overlay click is disabled so the user commits via Skip/Complete.
          - Escape during an active download is blocked to avoid orphaned UI
            (downloads continue in the background regardless). */}
      <Modal
        isOpen={showModelSetupWizard}
        onClose={handleModelSetupSkip}
        title="Set up on-device AI"
        description="Download the local models that power analysis, organization, and search."
        size="xl"
        closeOnOverlayClick={false}
        closeOnEsc={wizardStep !== 'downloading'}
        closeDisabled={wizardStep === 'downloading'}
        bodyClassName="px-4 py-4 sm:px-6"
      >
        <ModelSetupWizard
          embedded
          onComplete={handleModelSetupComplete}
          onSkip={handleModelSetupSkip}
          onStepChange={handleWizardStepChange}
        />
      </Modal>

      {/* Flows Modal */}
      <Modal
        isOpen={showFlowsModal}
        onClose={() => setShowFlowsModal(false)}
        title="How StratoSort works"
        size="md"
        footer={
          <Stack gap="compact" className="w-full">
            <Button
              onClick={() => {
                setShowFlowsModal(false);
                // Same guard as the primary Organize action (CP-21).
                actions.advancePhase(
                  hasSmartFolders ? (PHASES?.DISCOVER ?? 'discover') : (PHASES?.SETUP ?? 'setup')
                );
              }}
              variant="primary"
              size="sm"
              className="w-full"
            >
              Get started
            </Button>
          </Stack>
        }
      >
        <Stack gap="default">
          <Text variant="body">
            StratoSort follows a simple, review-first workflow so you stay in control before any
            files move.
          </Text>
          <Stack gap="cozy">
            {flowSteps.map((item, idx) => (
              <div
                key={item.title}
                className="flex items-start bg-system-gray-50 rounded-lg p-4 gap-default"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-stratosort-blue/10 flex items-center justify-center">
                  <item.icon className="w-5 h-5 text-stratosort-blue" />
                </div>
                <div className="flex-1">
                  <Caption className="block text-system-gray-400 mb-1">Step {idx + 1}</Caption>
                  <Heading as="h3" variant="h6" className="mb-1">
                    {item.title}
                  </Heading>
                  <Text variant="small">{item.copy}</Text>
                </div>
              </div>
            ))}
          </Stack>
        </Stack>
      </Modal>
    </div>
  );
}

export default WelcomePhase;
