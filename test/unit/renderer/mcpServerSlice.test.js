'use strict';
const reducer = require('../../../src/renderer/store/slices/mcpServerSlice').default;
const {
  enableMcpServer,
  disableMcpServer,
  rotateToken,
  refreshStatus
} = require('../../../src/renderer/store/slices/mcpServerSlice');

describe('mcpServerSlice', () => {
  test('initial state', () => {
    const s = reducer(undefined, { type: '@@INIT' });
    expect(s).toEqual({
      enabled: false,
      status: 'stopped',
      port: null,
      tokenMasked: null,
      lastError: null,
      isWorking: false
    });
  });

  test('enable.fulfilled marks running with port and tokenMasked', () => {
    const s = reducer(
      undefined,
      enableMcpServer.fulfilled({ port: 53827, tokenMasked: 'abcd....' }, 'req')
    );
    expect(s.status).toBe('running');
    expect(s.port).toBe(53827);
    expect(s.enabled).toBe(true);
  });

  test('disable.fulfilled returns to stopped', () => {
    const s = reducer(
      {
        status: 'running',
        enabled: true,
        port: 53827,
        tokenMasked: 'abcd',
        lastError: null,
        isWorking: false
      },
      disableMcpServer.fulfilled()
    );
    expect(s.status).toBe('stopped');
    expect(s.enabled).toBe(false);
    expect(s.port).toBe(null);
  });

  test('refreshStatus.fulfilled merges only the status allowlist, not arbitrary payload keys', () => {
    const s = reducer(
      undefined,
      refreshStatus.fulfilled(
        // A future/rogue payload carrying extra keys must NOT leak into state.
        { status: 'running', port: 42, enabled: true, isWorking: true, lastError: 'leak' },
        'req'
      )
    );
    expect(s.status).toBe('running');
    expect(s.port).toBe(42);
    expect(s.enabled).toBe(true);
    // Control flags owned by the slice are untouched by the IPC payload.
    expect(s.isWorking).toBe(false);
    expect(s.lastError).toBe(null);
  });

  test('refreshStatus.rejected surfaces the error in lastError', () => {
    const s = reducer(undefined, refreshStatus.rejected(new Error('status() failed'), 'req'));
    expect(s.lastError).toBe('status() failed');
  });
});
