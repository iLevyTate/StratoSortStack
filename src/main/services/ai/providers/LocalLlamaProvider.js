// @ts-check
'use strict';
const { AIProviderError } = require('../errors');

class LocalLlamaProvider {
  constructor(/** @type {any} */ llamaService) {
    this._llama = llamaService || null;
    this.id = 'local';
    this.displayName = 'Local Llama';
  }

  ready() {
    if (!this._llama || typeof this._llama.isModelReady !== 'function') return false;
    try {
      return Boolean(this._llama.isModelReady('text'));
    } catch {
      return false;
    }
  }

  async analyze(/** @type {any} */ prompt, options = {}) {
    if (!this._llama) {
      throw new AIProviderError('NO_PROVIDER_READY', 'Local LLM is not loaded');
    }
    try {
      return await this._llama.analyzeText(prompt, options);
    } catch (err) {
      throw new AIProviderError('PROVIDER_FAILED', err?.message || 'local analyze failed', {
        cause: err
      });
    }
  }

  async suggest(/** @type {any} */ prompt, options = {}) {
    return this.analyze(prompt, options);
  }

  async chatStream(payload = {}) {
    if (!this._llama) {
      throw new AIProviderError('NO_PROVIDER_READY', 'Local LLM is not loaded');
    }
    try {
      return await this._llama.generateTextStreaming(payload);
    } catch (err) {
      throw new AIProviderError('PROVIDER_FAILED', err?.message || 'local stream failed', {
        cause: err
      });
    }
  }
}

module.exports = { LocalLlamaProvider };
