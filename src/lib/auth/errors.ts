/**
 * Stable application error codes reused across auth and API layers.
 * Codes are safe to expose to clients; messages must stay generic for
 * security-sensitive failures (e.g. never reveal whether an email exists).
 */
export const ErrorCodes = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  RATE_LIMITED: 'RATE_LIMITED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  TOTP_REQUIRED: 'TOTP_REQUIRED',
  TOTP_INVALID: 'TOTP_INVALID',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Application error carrying a stable code and an HTTP status. */
export class AppError extends Error {
  public code: string;
  public status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/**
 * Converts an unknown thrown value into a client-safe `{ code, message }`.
 * Never leaks stack traces or internal error details: non-AppError values
 * collapse to INTERNAL_ERROR with a generic message.
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }
  return { code: ErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred' };
}
