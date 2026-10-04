#!/usr/bin/env node
'use strict';

const { LocalLlamaProvider } = require('../src/main/services/ai/providers/LocalLlamaProvider');
const { AnthropicProvider } = require('../src/main/services/ai/providers/AnthropicProvider');
const {
  OpenAICompatibleProvider
} = require('../src/main/services/ai/providers/OpenAICompatibleProvider');

const REQUIRED_METHODS = ['ready', 'analyze', 'suggest', 'chatStream'];
const REQUIRED_PROPERTIES = ['id', 'displayName'];

function assertProviderShape(name, instance) {
  const errors = [];
  for (const m of REQUIRED_METHODS) {
    if (typeof instance[m] !== 'function') {
      errors.push(`  ${name}.${m} is missing or not a function`);
    }
  }
  for (const p of REQUIRED_PROPERTIES) {
    if (typeof instance[p] !== 'string' || !instance[p]) {
      errors.push(`  ${name}.${p} is missing or not a string`);
    }
  }
  return errors;
}

(async () => {
  const allErrors = [];

  // LocalLlamaProvider: accepts llamaService with isModelReady method
  const local = new LocalLlamaProvider({ isModelReady: () => false });
  allErrors.push(...assertProviderShape('LocalLlamaProvider', local));
  if (local.id !== 'local') allErrors.push('  LocalLlamaProvider.id must be "local"');

  // The real LlamaService MUST expose the sync isModelReady(type) method the
  // LocalLlamaProvider calls. Asserting only the provider against a mock (above)
  // previously let a missing LlamaService.isModelReady ship — the provider then
  // permanently reported ready:false. Verify the production contract directly.
  const { LlamaService } = require('../src/main/services/LlamaService');
  if (typeof LlamaService.prototype.isModelReady !== 'function') {
    allErrors.push(
      '  LlamaService.isModelReady is missing — LocalLlamaProvider.ready() will always be false'
    );
  }

  // AnthropicProvider: getKey is required
  const anthropic = new AnthropicProvider({
    getKey: () => Promise.resolve(null),
    model: 'claude-opus-4-7'
  });
  allErrors.push(...assertProviderShape('AnthropicProvider', anthropic));
  if (anthropic.id !== 'anthropic') allErrors.push('  AnthropicProvider.id must be "anthropic"');

  // OpenAICompatibleProvider: getKey and baseUrl are required
  const openai = new OpenAICompatibleProvider({
    getKey: () => Promise.resolve(null),
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1'
  });
  allErrors.push(...assertProviderShape('OpenAICompatibleProvider', openai));
  if (openai.id !== 'openaiCompatible') {
    allErrors.push('  OpenAICompatibleProvider.id must be "openaiCompatible"');
  }

  // Verify ready() returns false for unconfigured providers (without throwing)
  try {
    const localReady = await local.ready();
    if (localReady !== false)
      allErrors.push('  LocalLlamaProvider.ready() should be false when no model loaded');
  } catch (err) {
    allErrors.push(`  LocalLlamaProvider.ready() threw: ${err.message}`);
  }

  try {
    const anthropicReady = await anthropic.ready();
    if (anthropicReady !== false)
      allErrors.push('  AnthropicProvider.ready() should be false when no key');
  } catch (err) {
    allErrors.push(`  AnthropicProvider.ready() threw: ${err.message}`);
  }

  try {
    const openaiReady = await openai.ready();
    if (openaiReady !== false)
      allErrors.push('  OpenAICompatibleProvider.ready() should be false when no key');
  } catch (err) {
    allErrors.push(`  OpenAICompatibleProvider.ready() threw: ${err.message}`);
  }

  if (allErrors.length > 0) {
    console.error('AI provider contract violations:');
    for (const e of allErrors) console.error(e);
    process.exit(1);
  }

  console.log('AI provider contracts OK');
})().catch((err) => {
  console.error('verify-ai-provider-contracts crashed:', err);
  process.exit(2);
});
