// Global Privacy Control (GPC): reads the `Sec-GPC: 1` request signal. A browser or extension sends it
// to assert the visitor does not consent to the tracking/sale of PERSONAL data. It no longer drops the
// event — an anonymous, cookieless pageview carries no personal data, so it is still counted so total
// traffic stays accurate. Instead GPC forces the anonymous Tier-0 hash (a GPC visitor is never
// identity-elevated), and experiment/flag exposure still self-gates on it. A deliberate client opt-out
// (kill switch / data-facet-optout) sends no beacon at all. See https://globalprivacycontrol.github.io/gpc-spec/.

/** True when the request carries the GPC signal (`Sec-GPC: 1`). */
export function isGpcOptOut(req: Request): boolean {
	return req.headers.get('Sec-GPC') === '1';
}
