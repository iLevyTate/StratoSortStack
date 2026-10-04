import React from 'react';
import PropTypes from 'prop-types';
import { Cloud, Cpu } from 'lucide-react';

const PROVIDER_META = {
  local: {
    label: 'Local Llama',
    title: 'Analyzed locally — no data left this machine',
    Icon: Cpu,
    tone: 'text-system-gray-500'
  },
  anthropic: {
    label: 'Anthropic Claude',
    title: 'Analyzed in the cloud by Anthropic Claude',
    Icon: Cloud,
    tone: 'text-stratosort-blue'
  },
  openaiCompatible: {
    label: 'OpenAI / Custom',
    title: 'Analyzed in the cloud by OpenAI-compatible provider',
    Icon: Cloud,
    tone: 'text-stratosort-blue'
  }
};

/**
 * Per-row indicator showing which provider produced an analysis result.
 * Renders nothing for unknown provider ids — callers may not always have
 * a provider stamped on legacy results, and silence is preferable to a
 * misleading default.
 */
function AIProviderIcon({ provider, className = '' }) {
  const meta = PROVIDER_META[provider];
  if (!meta) return null;

  const { label, title, Icon, tone } = meta;
  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className={`inline-flex items-center ${tone} ${className}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

AIProviderIcon.propTypes = {
  provider: PropTypes.string,
  className: PropTypes.string
};

export default React.memo(AIProviderIcon);
