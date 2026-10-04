import React from 'react';
import { Cloud } from 'lucide-react';
import { useAppSelector } from '../../store/hooks';
import {
  AI_CLOUD_ROUTING_SCOPE_DETAIL,
  describeOperationRouting,
  isCloudRoutingActive
} from '../../../shared/aiProviderRouting';

const PROVIDER_LABELS = {
  local: 'Local Llama',
  anthropic: 'Anthropic Claude',
  openaiCompatible: 'OpenAI / Custom'
};

function labelFor(providerId) {
  return PROVIDER_LABELS[providerId] || providerId;
}

/**
 * Compact header indicator shown when any routed operation (document
 * analysis, chat or organization suggestions) resolves to a cloud provider
 * that is enabled and ready. The tooltip names where each operation goes
 * when they differ.
 */
function AIProviderBadge() {
  const settings = useAppSelector((s) => s.aiProvider?.settings);
  const status = useAppSelector((s) => s.aiProvider?.status);

  if (!isCloudRoutingActive(settings, status)) return null;

  const routes = describeOperationRouting(settings, status);
  const distinct = new Set(routes.map((route) => route.providerId));
  const summary =
    distinct.size === 1
      ? `Cloud AI — ${labelFor(routes[0].providerId)}.`
      : `Cloud AI: ${routes
          .map((route) => {
            const where =
              route.providerId === 'local' || route.ready
                ? labelFor(route.providerId)
                : `${labelFor(route.providerId)} (not ready, Local Llama for now)`;
            return `${route.label.toLowerCase()} on ${where}`;
          })
          .join(', ')}.`;
  const tooltip = `${summary} ${AI_CLOUD_ROUTING_SCOPE_DETAIL}`;

  return (
    <span
      role="status"
      aria-label={tooltip}
      title={tooltip}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stratosort-blue/35 bg-stratosort-blue/10 text-stratosort-blue"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

export default React.memo(AIProviderBadge);
