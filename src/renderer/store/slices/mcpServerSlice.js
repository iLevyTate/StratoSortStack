// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// Preload exposes the IPC bridge under `electronAPI`, not `api`. Reading
// from `window.api` (the original v3.0 typo) silently returns undefined →
// optional chaining swallows every thunk → MCP UI is fully nonfunctional.
const _api = () => window.electronAPI?.mcp;

export const enableMcpServer = createAsyncThunk('mcp/enable', async () => _api().enable());
export const disableMcpServer = createAsyncThunk('mcp/disable', async () => _api().disable());
export const rotateToken = createAsyncThunk('mcp/rotateToken', async () => _api().rotateToken());
export const getConfigSnippet = createAsyncThunk('mcp/getConfigSnippet', async (client) =>
  _api().getConfigSnippet(client)
);
export const testConnection = createAsyncThunk('mcp/testConnection', async () =>
  _api().testConnection()
);
export const refreshStatus = createAsyncThunk('mcp/refreshStatus', async () => _api().status());

/** @type {any} */
const initialState = {
  enabled: false,
  status: 'stopped',
  port: null,
  tokenMasked: null,
  lastError: null,
  isWorking: false
};

// Single source of truth for merging an MCP status payload into state.
// Allowlists only the three fields McpServerLifecycleService.status() emits so
// neither the push event nor the refresh thunk can leak an unexpected payload
// key (e.g. a future `token`/`isWorking`) into Redux state.
function applyStatusPayload(/** @type {any} */ state, /** @type {any} */ payload) {
  const { status, port, enabled } = payload || {};
  if (status) state.status = status;
  if (typeof port === 'number' || port === null) state.port = port;
  if (typeof enabled === 'boolean') state.enabled = enabled;
}

const slice = createSlice({
  name: 'mcp',
  initialState,
  reducers: {
    statusPushed(state, action) {
      applyStatusPayload(state, action.payload);
    }
  },
  extraReducers: (b) => {
    b.addCase(enableMcpServer.pending, (s) => {
      s.isWorking = true;
      s.lastError = null;
    })
      .addCase(enableMcpServer.fulfilled, (s, a) => {
        s.isWorking = false;
        s.status = 'running';
        s.enabled = true;
        // Defensively coalesce in case main returns a partial payload
        // (e.g. lifecycle reports "already running" without echoing the
        // port). Without these guards, undefined wipes a previously valid
        // value.
        if (a.payload?.port != null) s.port = a.payload.port;
        if (a.payload?.tokenMasked != null) s.tokenMasked = a.payload.tokenMasked;
      })
      .addCase(enableMcpServer.rejected, (s, a) => {
        s.isWorking = false;
        s.status = 'error';
        s.lastError = a.error?.message || 'Failed to enable MCP server';
      })
      .addCase(disableMcpServer.pending, (s) => {
        s.isWorking = true;
        s.lastError = null;
      })
      .addCase(disableMcpServer.fulfilled, (s) => {
        s.isWorking = false;
        s.status = 'stopped';
        s.enabled = false;
        s.port = null;
      })
      .addCase(disableMcpServer.rejected, (s, a) => {
        // Without this branch, a failed disable() left isWorking permanently
        // true and the toggle stayed greyed out. Surface the error instead
        // and let the user retry.
        s.isWorking = false;
        s.status = 'error';
        s.lastError = a.error?.message || 'Failed to disable MCP server';
      })
      .addCase(rotateToken.pending, (s) => {
        s.isWorking = true;
      })
      .addCase(rotateToken.fulfilled, (s, a) => {
        s.isWorking = false;
        if (a.payload?.tokenMasked != null) s.tokenMasked = a.payload.tokenMasked;
      })
      .addCase(rotateToken.rejected, (s, a) => {
        s.isWorking = false;
        s.lastError = a.error?.message || 'Failed to rotate MCP token';
      })
      .addCase(refreshStatus.fulfilled, (s, a) => {
        applyStatusPayload(s, a.payload);
      })
      .addCase(refreshStatus.rejected, (s, a) => {
        s.lastError = a.error?.message || 'Failed to refresh MCP server status';
      });
  }
});

export const { statusPushed } = slice.actions;
export default slice.reducer;
