/**
 * @jest-environment node
 *
 * The main process's CircuitBreaker throws "Circuit breaker is OPEN for
 * llama-text". The notification mapper used to match only "circuit breaker
 * open", so users saw the raw message instead of the recovering copy.
 * (toErrorMessage is a plain normalizer and is not expected to translate.)
 */

const { mapErrorToNotification } = require('../src/renderer/utils/errorMapping');

describe('errorMapping: open circuit breaker', () => {
  const recovering = 'AI service is temporarily recovering. Please wait a moment and try again.';

  test('maps the breaker message that CircuitBreaker.execute actually throws', () => {
    expect(
      mapErrorToNotification({ error: new Error('Circuit breaker is OPEN for llama-text') })
    ).toMatchObject({ message: recovering, severity: 'warning' });
    expect(
      mapErrorToNotification({ error: 'Circuit breaker is OPEN for llama-embedding' })
    ).toMatchObject({
      message: recovering
    });
  });

  test('still maps the older spelling and the generic phrase', () => {
    expect(mapErrorToNotification({ error: 'circuit breaker open' })).toMatchObject({
      message: recovering
    });
    expect(mapErrorToNotification({ error: 'Service temporarily unavailable' })).toMatchObject({
      message: recovering
    });
  });
});
