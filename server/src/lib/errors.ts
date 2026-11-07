// API errors. Throw them anywhere; app.onError renders `{ error: { code, message } }`.
// Codes are part of the API contract (docs/API.md) and are translated by the clients.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (message: string) => new ApiError(400, "bad_request", message);
export const unauthorized = (message = "login required") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "permission denied") => new ApiError(403, "forbidden", message);
export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code = "conflict", message?: string) => new ApiError(409, code, message);
export const notConfigured = (message: string) => new ApiError(503, "not_configured", message);
