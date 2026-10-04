// @ts-check
'use strict';

/**
 * Settings panel search index and matching helpers.
 *
 * Multiple entries may share the same `id` (parent collapsible). Search matches
 * when the full query appears in the haystack OR when every significant token
 * (stop words removed) appears somewhere in title + keywords — so "chat with
 * documents" matches the Chat persona entry.
 */

const SETTINGS_SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with'
]);

const SETTINGS_SECTION_INDEX = [
  {
    id: 'settings-experience',
    title: 'Experience level',
    keywords: ['experience', 'mode', 'simple', 'advanced', 'beginner', 'expert']
  },
  {
    id: 'settings-appearance',
    title: 'Appearance',
    keywords: [
      'appearance',
      'theme',
      'themes',
      'color',
      'colour',
      'palette',
      'dark',
      'light',
      'primary',
      'mode',
      'display'
    ]
  },
  {
    id: 'settings-ai-provider',
    title: 'AI Provider',
    keywords: [
      'ai',
      'provider',
      'cloud',
      'openai',
      'anthropic',
      'claude',
      'gpt',
      'api',
      'key',
      'routing',
      'default',
      'external',
      'compatible'
    ]
  },
  {
    id: 'settings-mcp',
    title: 'MCP Server',
    keywords: [
      'mcp',
      'server',
      'claude',
      'cursor',
      'zed',
      'integration',
      'token',
      'bearer',
      'client',
      'tools',
      'protocol'
    ]
  },
  {
    id: 'settings-ai',
    title: 'AI Configuration',
    keywords: ['ai', 'llama', 'model', 'models', 'configuration', 'inference']
  },
  {
    id: 'settings-ai',
    title: 'Local AI engine',
    keywords: [
      'local',
      'llama',
      'engine',
      'download',
      'gguf',
      'gpu',
      'cuda',
      'vulkan',
      'models',
      'text model',
      'vision model'
    ]
  },
  {
    id: 'settings-ai',
    title: 'Model selection',
    advancedOnly: true,
    keywords: ['model', 'text', 'vision', 'embedding', 'analysis', 'ocr', 'select', 'switch']
  },
  {
    id: 'settings-ai',
    title: 'Chat persona',
    advancedOnly: true,
    keywords: [
      'chat',
      'persona',
      'documents',
      'document',
      'knowledge',
      'knowledge os',
      'semantic',
      'search',
      'conversation',
      'assistant',
      'tone',
      'personality',
      'prompt',
      'custom persona',
      'chat with documents'
    ]
  },
  {
    id: 'settings-ai',
    title: 'Model management',
    advancedOnly: true,
    keywords: ['model', 'manage', 'add', 'remove', 'custom', 'gguf', 'import', 'download']
  },
  {
    id: 'settings-ai',
    title: 'Embedding behavior',
    advancedOnly: true,
    keywords: ['embedding', 'embeddings', 'vector', 'vectors', 'semantic', 'index', 'orama']
  },
  {
    id: 'settings-ai',
    title: 'Embedding rebuild',
    advancedOnly: true,
    keywords: ['embedding', 'rebuild', 'reindex', 're-embed', 'vectors', 'refresh index']
  },
  {
    id: 'settings-performance',
    title: 'Performance',
    keywords: ['performance', 'speed', 'throughput', 'background', 'processing']
  },
  {
    id: 'settings-performance',
    title: 'Auto-organize',
    keywords: ['auto', 'organize', 'automatic', 'organization', 'suggestions', 'folder']
  },
  {
    id: 'settings-performance',
    title: 'Background mode',
    keywords: ['background', 'idle', 'system tray', 'minimize', 'processing']
  },
  {
    id: 'settings-performance',
    title: 'Graph retrieval',
    advancedOnly: true,
    keywords: [
      'graph',
      'knowledge graph',
      'retrieval',
      'semantic',
      'search',
      'neighbors',
      'rag',
      'context',
      'knowledge os'
    ]
  },
  {
    id: 'settings-performance',
    title: 'Processing limits',
    advancedOnly: true,
    keywords: [
      'limits',
      'concurrency',
      'parallel',
      'threads',
      'batch',
      'queue',
      // "Describe video keyframes" lives in this card.
      'video',
      'keyframe',
      'keyframes',
      'caption',
      'describe'
    ]
  },
  {
    id: 'settings-performance',
    title: 'Exclusion rules',
    keywords: ['exclusion', 'exclude', 'ignore', 'skip', 'rules', 'patterns', 'glob']
  },
  {
    id: 'settings-defaults',
    title: 'Default Locations',
    keywords: ['folder', 'destination', 'naming', 'path', 'default', 'location', 'smart folder']
  },
  {
    id: 'settings-defaults',
    title: 'Naming settings',
    keywords: ['naming', 'rename', 'filename', 'pattern', 'template', 'convention']
  },
  {
    id: 'settings-app',
    title: 'Application',
    keywords: ['application', 'app', 'preferences', 'general']
  },
  {
    id: 'settings-app',
    title: 'Application preferences',
    keywords: [
      'startup',
      'launch',
      'language',
      'theme',
      'updates',
      'watch',
      'smart folder',
      'watcher',
      'filesystem'
    ]
  },
  {
    id: 'settings-app',
    title: 'Notifications',
    keywords: ['notification', 'notifications', 'toast', 'tray', 'alert', 'sound']
  },
  {
    id: 'settings-app',
    title: 'About',
    keywords: ['about', 'version', 'bug', 'report', 'feedback', 'support']
  },
  {
    id: 'settings-app',
    title: 'Third-Party Notices',
    keywords: ['license', 'legal', 'privacy', 'notices', 'attribution', 'third party']
  },
  {
    id: 'settings-app',
    title: 'Settings backup',
    advancedOnly: true,
    keywords: ['backup', 'restore', 'export', 'import', 'save', 'settings file']
  },
  {
    id: 'settings-history',
    title: 'Analysis History',
    keywords: ['history', 'log', 'past', 'previous', 'analysis', 'results', 'statistics']
  },
  {
    id: 'settings-diagnostics',
    title: 'Diagnostics',
    advancedOnly: true,
    keywords: ['diagnostics', 'debug', 'advanced', 'troubleshoot', 'support']
  },
  {
    id: 'settings-diagnostics',
    title: 'Diagnostics snapshot',
    advancedOnly: true,
    keywords: ['snapshot', 'export', 'debug', 'support bundle', 'diagnostics']
  },
  {
    id: 'settings-diagnostics',
    title: 'Diagnostics logs',
    advancedOnly: true,
    keywords: ['logs', 'logging', 'jsonl', 'export logs', 'debug']
  },
  {
    id: 'settings-diagnostics',
    title: 'External AI clients',
    advancedOnly: true,
    keywords: ['mcp', 'external', 'claude desktop', 'cursor', 'api test', 'integration']
  }
];

/**
 * @param {string} normalizedQuery
 * @returns {string[]}
 */
function tokenizeSettingsQuery(normalizedQuery) {
  if (!normalizedQuery) return [];
  return normalizedQuery
    .split(/\s+/)
    .map((/** @type {string} */ t) => t.trim())
    .filter((/** @type {string} */ t) => t.length > 0 && !SETTINGS_SEARCH_STOP_WORDS.has(t));
}

/**
 * @param {{ title: string, keywords?: string[] }} section
 * @returns {string}
 */
function sectionHaystack(section) {
  return `${section.title} ${(section.keywords || []).join(' ')}`.toLowerCase();
}

/**
 * @param {{ title: string, keywords?: string[], advancedOnly?: boolean }} section
 * @param {string} normalizedQuery
 * @returns {boolean}
 */
function sectionMatchesQuery(section, normalizedQuery) {
  if (!normalizedQuery) return true;
  const haystack = sectionHaystack(section);
  if (haystack.includes(normalizedQuery)) return true;

  const tokens = tokenizeSettingsQuery(normalizedQuery);
  if (tokens.length === 0) {
    return haystack.includes(normalizedQuery);
  }
  return tokens.every((token) => haystack.includes(token));
}

/**
 * @param {string} query - Raw search box value
 * @param {typeof SETTINGS_SECTION_INDEX} [index]
 * @returns {{ sectionIds: Set<string>|null, revealAdvanced: boolean }}
 */
function matchSettingsSections(query, index = SETTINGS_SECTION_INDEX) {
  const normalized = String(query || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return { sectionIds: null, revealAdvanced: false };
  }

  const sectionIds = new Set();
  let revealAdvanced = false;
  for (const section of index) {
    if (sectionMatchesQuery(section, normalized)) {
      sectionIds.add(section.id);
      if (section.advancedOnly) revealAdvanced = true;
    }
  }
  return { sectionIds, revealAdvanced };
}

module.exports = {
  SETTINGS_SEARCH_STOP_WORDS,
  SETTINGS_SECTION_INDEX,
  tokenizeSettingsQuery,
  sectionMatchesQuery,
  matchSettingsSections
};
