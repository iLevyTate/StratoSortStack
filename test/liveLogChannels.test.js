/**
 * Live Activity IPC channel wiring: two invoke channels (subscribe /
 * unsubscribe) and one push-only batch channel, registered everywhere the
 * IPC verify scripts and the preload allowlists look. The batch channel joins
 * the receive allowlist together with its preload safeOn bridge, because
 * securityConfig.test.js requires every allowed receive channel to have a
 * preload consumer.
 */
const fs = jest.requireActual('fs');
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants');
const { EVENT_ONLY_CHANNELS } = require('../src/shared/ipcEnforcement');

describe('live log IPC channels', () => {
  test('are defined in the SYSTEM group', () => {
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE).toBe('system:live-log:subscribe');
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE).toBe('system:live-log:unsubscribe');
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH).toBe('system:live-log:batch');
  });

  test('the batch channel is push-only; the invoke channels are not', () => {
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:batch')).toBe(true);
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:subscribe')).toBe(false);
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:unsubscribe')).toBe(false);
  });

  test('the generated preload channel block carries all three channels', () => {
    const preload = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
    expect(preload).toContain("LIVE_LOG_SUBSCRIBE: 'system:live-log:subscribe'");
    expect(preload).toContain("LIVE_LOG_UNSUBSCRIBE: 'system:live-log:unsubscribe'");
    expect(preload).toContain("LIVE_LOG_BATCH: 'system:live-log:batch'");
  });

  test('the renderer may receive the batch channel', () => {
    const { ALLOWED_RECEIVE_CHANNELS } = require('../src/shared/securityConfig');
    expect(ALLOWED_RECEIVE_CHANNELS).toContain('system:live-log:batch');
  });

  test('verify-ipc-handlers knows the batch channel has no invoke handler', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../scripts/verify-ipc-handlers.js'),
      'utf8'
    );
    expect(script).toContain("'SYSTEM.LIVE_LOG_BATCH'");
  });
});
