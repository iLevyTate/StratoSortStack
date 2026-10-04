// @ts-check
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

const _api = () => window.electronAPI?.license;

export const fetchLicenseStatus = createAsyncThunk('license/fetchStatus', async () =>
  _api()?.getStatus()
);
export const activateLicense = createAsyncThunk('license/activate', async (key) =>
  _api()?.activate(key)
);
export const deactivateLicense = createAsyncThunk('license/deactivate', async () =>
  _api()?.deactivate()
);

/** @type {any} */
const initialState = {
  loaded: false,
  // Mirrors LicenseService.getSnapshot(). Informational only: no feature
  // reads it to decide whether it may run.
  snapshot: {
    state: 'free',
    edition: null,
    name: null,
    seats: null,
    maintenanceUntil: null,
    buildDate: null
  },
  isWorking: false,
  lastError: null
};

function applySnapshot(/** @type {any} */ state, /** @type {any} */ payload) {
  const snapshot = payload?.snapshot;
  if (snapshot && typeof snapshot === 'object' && typeof snapshot.state === 'string') {
    state.snapshot = snapshot;
    state.loaded = true;
  }
}

const slice = createSlice({
  name: 'license',
  initialState,
  reducers: {},
  extraReducers: (b) => {
    b.addCase(fetchLicenseStatus.fulfilled, (s, a) => {
      applySnapshot(s, a.payload);
    })
      .addCase(fetchLicenseStatus.rejected, (s, a) => {
        s.loaded = true;
        s.lastError = a.error?.message || null;
      })
      .addCase(activateLicense.pending, (s) => {
        s.isWorking = true;
        s.lastError = null;
      })
      .addCase(activateLicense.fulfilled, (s, a) => {
        s.isWorking = false;
        applySnapshot(s, a.payload);
      })
      .addCase(activateLicense.rejected, (s, a) => {
        s.isWorking = false;
        s.lastError = a.error?.message || 'Activation failed';
      })
      .addCase(deactivateLicense.pending, (s) => {
        s.isWorking = true;
        s.lastError = null;
      })
      .addCase(deactivateLicense.fulfilled, (s, a) => {
        s.isWorking = false;
        applySnapshot(s, a.payload);
      })
      .addCase(deactivateLicense.rejected, (s, a) => {
        s.isWorking = false;
        s.lastError = a.error?.message || 'Deactivation failed';
      });
  }
});

export const selectLicenseSnapshot = (/** @type {any} */ state) =>
  state.license?.snapshot || initialState.snapshot;
export const selectLicenseWorking = (/** @type {any} */ state) => Boolean(state.license?.isWorking);
export const selectLicenseError = (/** @type {any} */ state) => state.license?.lastError || null;

export default slice.reducer;
