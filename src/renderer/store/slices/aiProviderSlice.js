// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const _api = () => window.electronAPI?.aiProvider;

// Convert a thrown Error from `throwIfFailed` into a structured rejection
// so reducers can branch on `code` (e.g. CONSENT_REQUIRED, ENCRYPTION_UNAVAILABLE)
// instead of pattern-matching on err.message.
function _rejectWithCode(/** @type {any} */ thunkAPI, /** @type {any} */ err) {
  return thunkAPI.rejectWithValue({
    message: err?.message || String(err),
    code: err?.code || null
  });
}

export const fetchAiConfig = createAsyncThunk('aiProvider/fetch', async () => _api().getConfig(), {
  condition: (_, { getState }) => {
    const s = /** @type {any} */ (getState()).aiProvider;
    return !s?.loaded && !s?.isWorking;
  }
});
export const setProviderConfig = createAsyncThunk(
  'aiProvider/setProviderConfig',
  async (/** @type {{ provider: string, config: any }} */ { provider, config }, thunkAPI) => {
    try {
      return await _api().setProviderConfig(provider, config);
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
export const setProviderKey = createAsyncThunk(
  'aiProvider/setKey',
  async (
    /** @type {{ provider: string, key: string, allowPlaintext?: boolean }} */ {
      provider,
      key,
      allowPlaintext = false
    },
    thunkAPI
  ) => {
    try {
      return await _api().setKey(provider, key, { allowPlaintext });
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
export const removeProviderKey = createAsyncThunk(
  'aiProvider/removeKey',
  async (/** @type {{ provider: string }} */ { provider }, thunkAPI) => {
    try {
      return await _api().removeKey(provider);
    } catch (err) {
      // Match the other thunks: convert a thrown Error from throwIfFailed
      // into a structured rejection so the slice can populate lastError
      // and the UI can branch on err.code (e.g. ENCRYPTION_UNAVAILABLE
      // edge case where remove fails because the keystore can't be opened).
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
export const getKeyStatus = createAsyncThunk(
  'aiProvider/getKeyStatus',
  async (/** @type {{ provider: string }} */ { provider }, thunkAPI) => {
    try {
      return { provider, status: await _api().getKeyStatus(provider) };
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
export const testProvider = createAsyncThunk(
  'aiProvider/test',
  async (/** @type {{ provider: string }} */ { provider }, thunkAPI) => {
    try {
      return { provider, result: await _api().testProvider(provider) };
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
export const setRouting = createAsyncThunk(
  'aiProvider/setRouting',
  async (/** @type {any} */ routing, thunkAPI) => {
    try {
      return await _api().setRouting(routing);
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);
// Month-to-date spend per cloud provider plus cost-tracker health, for the
// spend-cap control in the provider config modal. Informational: a failure
// leaves the previous value in place and does not set lastError.
export const fetchUsage = createAsyncThunk('aiProvider/fetchUsage', async (_, thunkAPI) => {
  try {
    const api = _api();
    if (!api || typeof api.getUsage !== 'function') return null;
    return await api.getUsage();
  } catch (err) {
    return _rejectWithCode(thunkAPI, err);
  }
});
export const acknowledgeCloud = createAsyncThunk(
  'aiProvider/acknowledgeCloud',
  async (_, thunkAPI) => {
    try {
      return await _api().acknowledgeCloud();
    } catch (err) {
      return _rejectWithCode(thunkAPI, err);
    }
  }
);

// Note: apiKeyRef was previously declared here and on the main side, but no
// code ever read it — the keystore is keyed directly by provider name. Removed
// to avoid implying a contract that doesn't exist.
const DEFAULT_AI_SETTINGS = {
  providers: {
    local: { enabled: true, displayName: 'Local Llama' },
    anthropic: {
      enabled: false,
      displayName: 'Anthropic Claude',
      model: 'claude-opus-4-7'
    },
    openaiCompatible: {
      enabled: false,
      displayName: 'OpenAI / Custom',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o'
    }
  },
  routing: { default: 'local', perOperation: {}, perFolder: {} },
  consent: {}
};

/** @type {any} */
const initialState = {
  loaded: false,
  isWorking: false,
  lastError: null,
  settings: DEFAULT_AI_SETTINGS,
  status: { providers: [], routing: DEFAULT_AI_SETTINGS.routing },
  keyStatus: {
    anthropic: { hasKey: false, lastFour: null },
    openaiCompatible: { hasKey: false, lastFour: null }
  },
  testResults: {}, // provider -> { ok, latencyMs?, error? }
  usage: null // { thisMonth: { anthropic, openaiCompatible }, health } from GET_USAGE
};

const slice = createSlice({
  name: 'aiProvider',
  initialState,
  reducers: {
    statusPushed(state, action) {
      const { providers, routing, consent } = action.payload || {};
      if (providers) state.status.providers = providers;
      if (routing) {
        state.status.routing = routing;
        if (state.settings) {
          state.settings.routing = { ...state.settings.routing, ...routing };
        }
      }
      if (consent && state.settings) {
        state.settings.consent = { ...state.settings.consent, ...consent };
      }
    }
  },
  extraReducers: (b) => {
    b.addCase(fetchAiConfig.pending, (s) => {
      s.isWorking = true;
      s.lastError = null;
    })
      .addCase(fetchAiConfig.fulfilled, (s, a) => {
        s.isWorking = false;
        s.loaded = true;
        if (a.payload?.settings) s.settings = a.payload.settings;
        if (a.payload?.status) s.status = a.payload.status;
      })
      .addCase(fetchAiConfig.rejected, (s, a) => {
        s.isWorking = false;
        s.lastError = a.error.message;
      })
      .addCase(setProviderConfig.fulfilled, (s, a) => {
        if (a.payload?.status) s.status = a.payload.status;
        // Mirror provider config into settings so Configure… reopen reflects
        // the last Save (status.providers alone is not enough for the modal).
        const provider = a.meta.arg?.provider;
        const config = a.meta.arg?.config;
        if (provider && config && s.settings?.providers?.[provider]) {
          s.settings.providers[provider] = {
            ...s.settings.providers[provider],
            ...config
          };
        }
      })
      .addCase(setProviderConfig.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      })
      .addCase(setProviderKey.fulfilled, (s, a) => {
        const provider = a.meta.arg.provider;
        // Prefer lastFour from the IPC response if the main process echoed
        // it back (future-proofs against the provider class normalizing the
        // key). Falls back to the input slice. Guarded against malformed
        // args because reducers run inside Immer — throwing here turns into
        // a "non-serializable" error that breaks Redux DevTools time-travel.
        const key = typeof a.meta.arg?.key === 'string' ? a.meta.arg.key : '';
        const lastFour = a.payload?.lastFour ?? (key.length >= 4 ? key.slice(-4) : null);
        s.keyStatus[provider] = {
          hasKey: key.length > 0 || Boolean(a.payload?.lastFour),
          lastFour
        };
        if (a.payload?.status) s.status = a.payload.status;
      })
      .addCase(setProviderKey.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      })
      .addCase(removeProviderKey.fulfilled, (s, a) => {
        const provider = a.meta.arg.provider;
        s.keyStatus[provider] = { hasKey: false, lastFour: null };
        if (a.payload?.status) s.status = a.payload.status;
      })
      .addCase(removeProviderKey.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      })
      .addCase(getKeyStatus.fulfilled, (s, a) => {
        const { provider, status } = a.payload;
        if (status) {
          s.keyStatus[provider] = {
            hasKey: Boolean(status.hasKey),
            // Coalesce so a transient empty status response doesn't clobber a
            // previously known last-four with null.
            lastFour: status.lastFour ?? s.keyStatus[provider]?.lastFour ?? null
          };
        }
      })
      .addCase(getKeyStatus.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      })
      .addCase(testProvider.fulfilled, (s, a) => {
        const { provider, result } = a.payload;
        s.testResults[provider] = result;
      })
      .addCase(testProvider.rejected, (s, a) => {
        const provider = a.meta.arg.provider;
        s.testResults[provider] = {
          ok: false,
          error: /** @type {any} */ (a.payload)?.message || a.error.message
        };
      })
      .addCase(setRouting.fulfilled, (s, a) => {
        if (a.payload?.status) {
          s.status = a.payload.status;
          // Keep settings.routing in sync so consumers reading from settings
          // (AIProviderBadge, AIProviderSection) reflect the change without
          // waiting for a fetchAiConfig round-trip.
          if (a.payload.status.routing) s.settings.routing = a.payload.status.routing;
        }
      })
      .addCase(setRouting.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      })
      .addCase(fetchUsage.fulfilled, (s, a) => {
        if (a.payload && typeof a.payload === 'object') {
          s.usage = {
            thisMonth: a.payload.thisMonth || null,
            health: a.payload.health || null
          };
        }
      })
      .addCase(acknowledgeCloud.fulfilled, (s, a) => {
        if (a.payload?.status) s.status = a.payload.status;
        // Mirror consent into settings.consent so components reading from
        // settings (rather than IPC) see the latest acknowledgment without
        // waiting for fetchAiConfig.
        if (a.payload?.status?.consent) {
          s.settings.consent = { ...s.settings.consent, ...a.payload.status.consent };
        }
      })
      .addCase(acknowledgeCloud.rejected, (s, a) => {
        s.lastError = /** @type {any} */ (a.payload)?.message || a.error.message;
      });
  }
});

export const { statusPushed } = slice.actions;
export default slice.reducer;
