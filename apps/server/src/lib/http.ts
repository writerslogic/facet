// Canonical HTTP error type and constructors. Every error the API returns is an `ApiError`
// carrying a stable `code` (the fixed set in the contract) and its HTTP status; `app.onError`
// renders it to the canonical `{ error, message?, issues? }` envelope. Throwing one of the
// helpers below is the only way handlers signal a client/auth/rate error.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env.js';

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

/** One validation failure, reduced to the two things a caller can act on. */
interface ValidationIssue {
	/** Dotted path to the offending field, omitted for a whole-body failure. */
	path?: string;
	message: string;
}

/** The parts of a valibot issue this module reads. Structural, so `http.ts` stays valibot-free. */
interface RawIssue {
	message?: unknown;
	path?: readonly { key?: unknown }[];
}

/** Reduce raw valibot issues to `{ path, message }`.
 * A raw issue carries `path[].input`, which is the ENTIRE validated object — so returning issues
 * verbatim echoed every submitted field back to the caller, including a magic-link token
 * (`/api/auth/verify`) or arbitrary event props (`/api/collect`). It also pinned an internal
 * library shape as the public error contract. */
function toValidationIssues(issues: readonly unknown[] | undefined): ValidationIssue[] {
	return (issues ?? []).map((raw) => {
		const issue = raw as RawIssue;
		const path = issue.path?.map((p) => String(p.key)).join('.');
		const out: ValidationIssue = {
			message: typeof issue.message === 'string' ? issue.message : 'invalid value',
		};
		if (path) {
			out.path = path;
		}
		return out;
	});
}

/** Shared vValidator hook: on a valibot failure, render the canonical `validation_failed` envelope;
 * otherwise return undefined so the request proceeds. Replaces the byte-identical inline hook that
 * every validated route declared. */
export function validationErrorHook(
	result: { success: boolean; issues?: readonly unknown[] },
	c: Context<AppEnv>,
): Response | undefined {
	if (!result.success) {
		return c.json(
			{
				error: 'validation_failed',
				issues: toValidationIssues(result.issues),
			},
			400,
		);
	}
	return undefined;
}

export const badRequest = (code = 'bad_request', message?: string): ApiError =>
	new ApiError(code, 400, message);

export const unauthorized = (code = 'unauthorized', message?: string): ApiError =>
	new ApiError(code, 401, message);

export const forbidden = (code = 'site_mismatch', message?: string): ApiError =>
	new ApiError(code, 403, message);

export const tooManyRequests = (): ApiError => new ApiError('rate_limited', 429);

export const notFoundError = (): ApiError => new ApiError('not_found', 404);
