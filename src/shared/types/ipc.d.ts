/**
 * Cross-process IPC contracts. Runtime validation is Zod
 * (src/main/ipc/validationSchemas.js); these types are the compile-time
 * mirror. Prefer deriving payload types from the Zod schemas
 * (`import('zod').TypeOf<typeof schema>`) over hand-writing duplicates.
 *
 * Shapes below mirror the two envelope families actually produced by
 * src/main/ipc/ipcWrappers.js and consumed by preload's throwIfFailed:
 *   - structured format: error is an IpcErrorDetail object
 *     (errorHandlingUtils.createErrorResponse)
 *   - simple settings-style format: error is a string, with optional
 *     canceled / warnings / pending / unavailable markers
 */

/** Error detail produced by the structured format. */
export interface IpcErrorDetail {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Success envelope for object payloads: ipcWrappers.createSuccessResponse
 * SPREADS the payload into the envelope ({ success: true, ...data }).
 */
export type IpcSuccess<T extends object = Record<string, unknown>> = {
  success: true;
  warnings?: string[];
} & T;

/** Success envelope for non-object payloads ({ success: true, data }). */
export interface IpcDataSuccess<T = unknown> {
  success: true;
  data: T;
}

/**
 * Failure envelope. `error` is a string in the simple format, an
 * IpcErrorDetail in the structured format; throwIfFailed handles both,
 * plus top-level `message` and both canceled spellings. Extra fields
 * (validationErrors, code, unavailable, ...) are spread by errorResponse.
 */
export interface IpcFailure {
  success: false;
  error?: string | IpcErrorDetail;
  message?: string;
  code?: string;
  canceled?: boolean;
  cancelled?: boolean;
  pending?: boolean;
  unavailable?: boolean;
  [extra: string]: unknown;
}

export type IpcResult<T extends object = Record<string, unknown>> = IpcSuccess<T> | IpcFailure;
