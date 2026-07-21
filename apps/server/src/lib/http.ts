// Canonical HTTP error type and constructors. Every error the API returns is an `ApiError`
// carrying a stable `code` (the fixed set in the contract) and its HTTP status; `app.onError`
// renders it to the canonical `{ error, message?, issues? }` envelope. Throwing one of the
// helpers below is the only way handlers signal a client/auth/rate error.

import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
	constructor(
		public code: string,
		public status: ContentfulStatusCode,
		message?: string,
		public issues?: unknown,
	) {
		super(message ?? code);
		this.name = 'ApiError';
	}
}

/** Canonical error-response body: a stable `error` code, with optional detail. */
export interface ErrorBody {
	error: string;
	message?: string;
	issues?: unknown;
}

/** Render an `ApiError` to its wire body, omitting a `message` that only echoes the code. */
export function toErrorBody(err: ApiError): ErrorBody {
	const body: ErrorBody = { error: err.code };
	if (err.message && err.message !== err.code) {
		body.message = err.message;
	}
	if (err.issues !== undefined) {
		body.issues = err.issues;
	}
	return body;
}

export const badRequest = (code = 'bad_request', message?: string): ApiError =>
	new ApiError(code, 400, message);

export const unauthorized = (code = 'unauthorized', message?: string): ApiError =>
	new ApiError(code, 401, message);

export const forbidden = (code = 'site_mismatch', message?: string): ApiError =>
	new ApiError(code, 403, message);

export const tooManyRequests = (): ApiError => new ApiError('rate_limited', 429);

export const notFoundError = (): ApiError => new ApiError('not_found', 404);
