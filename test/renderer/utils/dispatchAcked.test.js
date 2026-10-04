/**
 * @jest-environment jsdom
 */
import { dispatchAcked } from '../../../src/renderer/utils/dispatchAcked';

describe('dispatchAcked (F-179 — first coverage)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('an acking listener (preventDefault) stops the retries', () => {
    const heard = jest.fn((e) => e.preventDefault());
    window.addEventListener('bridge:test-ack', heard);

    dispatchAcked('bridge:test-ack', { intervalMs: 100, maxAttempts: 30 });
    jest.advanceTimersByTime(1000);

    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener('bridge:test-ack', heard);
  });

  test('retries until a listener mounts late, then stops', () => {
    dispatchAcked('bridge:test-late', { detail: ['payload'], intervalMs: 100, maxAttempts: 30 });

    // No listener yet — retries are in flight.
    jest.advanceTimersByTime(250);

    const heard = jest.fn((e) => {
      e.preventDefault();
      expect(e.detail).toEqual(['payload']);
    });
    window.addEventListener('bridge:test-late', heard);
    jest.advanceTimersByTime(1000);

    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener('bridge:test-late', heard);
  });

  test('gives up after maxAttempts', () => {
    const unheard = jest.fn(); // never calls preventDefault
    window.addEventListener('bridge:test-max', unheard);

    dispatchAcked('bridge:test-max', { intervalMs: 100, maxAttempts: 3 });
    jest.advanceTimersByTime(10000);

    expect(unheard).toHaveBeenCalledTimes(3);
    window.removeEventListener('bridge:test-max', unheard);
  });

  test('cancel() stops pending retries so no orphaned loop fires later', () => {
    const heard = jest.fn();
    window.addEventListener('bridge:test-cancel', heard);

    const cancel = dispatchAcked('bridge:test-cancel', { intervalMs: 100, maxAttempts: 30 });
    expect(heard).toHaveBeenCalledTimes(1); // synchronous first attempt
    cancel();
    jest.advanceTimersByTime(5000);

    // No further attempts after cancel — a late-mounting listener can no
    // longer receive a surprise picker event from a stale loop.
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener('bridge:test-cancel', heard);
  });
});
