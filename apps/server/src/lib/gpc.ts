// Global Privacy Control (GPC): honors the `Sec-GPC: 1` request signal as an opt-out. A browser or
// extension sends `Sec-GPC: 1` to assert the visitor does not consent to tracking/sale of data.
// When present, ingest is skipped entirely — no event, session, or experiment exposure is written —
// mirroring the client-side opt-out precedence. See https://globalprivacycontrol.github.io/gpc-spec/.

/** True when the request carries the GPC opt-out signal (`Sec-GPC: 1`). */
export function isGpcOptOut(req: Request): boolean {
	return req.headers.get('Sec-GPC') === '1';
}
