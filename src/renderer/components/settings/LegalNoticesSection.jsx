import React from 'react';
import PropTypes from 'prop-types';
import { ScrollText, RefreshCw } from 'lucide-react';
import SettingsCard from './SettingsCard';
import Button from '../ui/Button';
import { Text } from '../ui/Typography';
import { logger } from '../../../shared/logger';
import { getElectronAPI } from '../../services/ipc';
import { toErrorMessage } from '../../utils/errorMapping';

/**
 * Legal Notices section.
 *
 * Surfaces the bundled `THIRD_PARTY_NOTICES.md` (shipped via electron-builder
 * extraResources). Required to honor the Llama 3.2 Community License's "Built
 * with Llama" attribution and to make the LGPL libvips/FFmpeg source-offer
 * notices reachable from inside the app — both are obligations the installer-
 * time license dialog alone doesn't fully discharge.
 */
function LegalNoticesSection({ addNotification }) {
  const [content, setContent] = React.useState('');
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const electronApi = getElectronAPI();
  const canFetch = typeof electronApi?.system?.getLegalNotices === 'function';

  // Resolves true when notices actually loaded, so the reload toast can't
  // announce success next to the section's own failure banner.
  const load = React.useCallback(async () => {
    if (!canFetch) {
      setError('Legal notices IPC unavailable in this build.');
      setLoading(false);
      return false;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await electronApi.system.getLegalNotices();
      if (result?.success && typeof result.content === 'string') {
        setContent(result.content);
        return true;
      }
      // result.error may be the structured { code, message, details } IPC
      // envelope — never render it directly (React #31 crash).
      setError(
        toErrorMessage(result?.error || result?.message, 'Failed to load third-party notices.')
      );
      return false;
    } catch (err) {
      logger.error('[Settings] Failed to load legal notices', { error: err });
      setError(err?.message || 'Failed to load third-party notices.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [canFetch, electronApi]);

  React.useEffect(() => {
    load();
  }, [load]);

  const handleReload = React.useCallback(async () => {
    const ok = await load();
    if (ok) {
      addNotification?.('Reloaded third-party notices.', 'info');
    }
    // On failure the inline alert banner explains what went wrong.
  }, [load, addNotification]);

  return (
    <SettingsCard
      title="Third-party notices"
      description="Attribution and license obligations for third-party libraries, runtimes, and models shipped with or used by the app (not for StratoSort itself)."
      headerAction={
        <Button
          variant="subtle"
          size="sm"
          onClick={handleReload}
          isLoading={loading}
          leftIcon={<RefreshCw className="w-4 h-4" />}
          aria-label="Reload third-party notices"
        >
          Reload
        </Button>
      }
    >
      <div className="flex items-start gap-compact text-system-gray-500">
        <ScrollText className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <Text variant="tiny" className="leading-relaxed">
          StratoSort Core is licensed for personal and noncommercial use; commercial use requires a
          paid license. The notices below apply only to third-party tools incorporated into the
          product—such as Electron, llama.cpp, FFmpeg, and AI model weights—each under its own
          license.
        </Text>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-stratosort-danger/30 bg-stratosort-danger/5 p-3 text-stratosort-danger text-xs"
        >
          {error}
        </div>
      ) : (
        <pre
          className="mt-2 p-4 bg-system-gray-50 text-system-gray-800 text-xs leading-relaxed rounded-lg overflow-auto max-h-96 whitespace-pre-wrap break-words border border-border-soft/40"
          aria-label="Third-party notices content"
        >
          {loading && !content ? 'Loading…' : content}
        </pre>
      )}
    </SettingsCard>
  );
}

LegalNoticesSection.propTypes = {
  addNotification: PropTypes.func
};

export default LegalNoticesSection;
