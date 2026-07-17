// Shared read-state classification. Every API-key read distinguishes:
//   loading | auth-error (401 / invalid_api_key) | error | empty (successful zero) | success.
// Auth failures must surface a banner and clear stale data, never render as a legitimate 0.

/** Error messages the API returns for an unrecognized/invalid API key. */
const AUTH_ERRORS = new Set(['invalid_api_key', 'unauthorized', 'missing_api_key']);

/** True when an error from a read indicates the API key/site was not accepted. */
export function isAuthError(error: unknown): boolean {
	return error instanceof Error && AUTH_ERRORS.has(error.message);
}

export type ReadStatus = 'loading' | 'auth-error' | 'error' | 'empty' | 'success';

/** Classify a react-query read into the shared status model. `isEmpty` marks a successful zero. */
export function readStatus(args: {
	isLoading: boolean;
	error: unknown;
	hasData: boolean;
	isEmpty?: boolean;
}): ReadStatus {
	if (args.error) return isAuthError(args.error) ? 'auth-error' : 'error';
	if (args.isLoading || !args.hasData) return 'loading';
	return args.isEmpty ? 'empty' : 'success';
}
