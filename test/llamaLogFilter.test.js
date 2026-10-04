/**
 * @jest-environment node
 *
 * Tests for llamaLogFilter.js:
 *  - isBenignTokenizerRoundtripWarning() matching
 *  - createFilteredLlamaLogger() suppresses the benign warning, forwards the rest
 *  - delegation to Llama.defaultConsoleLogger, plus the no-default fallback
 */

const {
  createFilteredLlamaLogger,
  isBenignTokenizerRoundtripWarning,
  TOKENIZER_ROUNDTRIP_MARKER
} = require('../src/main/utils/llamaLogFilter');

const ROUNDTRIP_WARNING =
  'Using this model ("/models/nomic-embed-text-v1.5-Q8_0.gguf") to tokenize text ' +
  'and then detokenize it resulted in a different text. There might be an issue ' +
  'with the model or the tokenizer implementation. Using this model may not work as intended';

describe('llamaLogFilter', () => {
  describe('isBenignTokenizerRoundtripWarning', () => {
    test('matches the tokenizer round-trip warning regardless of interpolated model path', () => {
      expect(isBenignTokenizerRoundtripWarning(ROUNDTRIP_WARNING)).toBe(true);
      expect(isBenignTokenizerRoundtripWarning(`prefix ${TOKENIZER_ROUNDTRIP_MARKER} suffix`)).toBe(
        true
      );
    });

    test('does not match unrelated warnings', () => {
      expect(isBenignTokenizerRoundtripWarning('Flash attention was turned off')).toBe(false);
      expect(isBenignTokenizerRoundtripWarning('failed to load model')).toBe(false);
    });

    test('is safe for non-string input', () => {
      expect(isBenignTokenizerRoundtripWarning(undefined)).toBe(false);
      expect(isBenignTokenizerRoundtripWarning(null)).toBe(false);
      expect(isBenignTokenizerRoundtripWarning(42)).toBe(false);
      expect(isBenignTokenizerRoundtripWarning({})).toBe(false);
    });
  });

  describe('createFilteredLlamaLogger', () => {
    test('suppresses the benign warning and forwards everything else to the library default', () => {
      const defaultConsoleLogger = jest.fn();
      const logger = createFilteredLlamaLogger({ Llama: { defaultConsoleLogger } });

      logger('warn', ROUNDTRIP_WARNING);
      expect(defaultConsoleLogger).not.toHaveBeenCalled();

      logger('warn', 'some other warning');
      logger('error', 'a real error');
      expect(defaultConsoleLogger).toHaveBeenCalledTimes(2);
      expect(defaultConsoleLogger).toHaveBeenNthCalledWith(1, 'warn', 'some other warning');
      expect(defaultConsoleLogger).toHaveBeenNthCalledWith(2, 'error', 'a real error');
    });

    test('preserves Llama as `this` when delegating (defaultConsoleLogger is a static method)', () => {
      const Llama = {
        marker: 'llama-static',
        defaultConsoleLogger(level, message) {
          this.captured = { self: this.marker, level, message };
        }
      };
      const logger = createFilteredLlamaLogger({ Llama });

      logger('info', 'hello');
      expect(Llama.captured).toEqual({ self: 'llama-static', level: 'info', message: 'hello' });
    });

    test('falls back to console routing when no default logger is available', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const logger = createFilteredLlamaLogger(undefined);

        logger('warn', ROUNDTRIP_WARNING);
        expect(warnSpy).not.toHaveBeenCalled();

        logger('warn', 'visible warning');
        expect(warnSpy).toHaveBeenCalledWith('[node-llama-cpp] visible warning');
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('fallback routes unknown levels to console.log', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = createFilteredLlamaLogger({ Llama: {} });

        // 'fatal' is not a console method, so the fallback routes it to console.log.
        logger('fatal', 'low-level detail');
        expect(logSpy).toHaveBeenCalledWith('[node-llama-cpp] low-level detail');
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
