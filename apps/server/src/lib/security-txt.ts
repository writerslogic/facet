// RFC 9116 `security.txt` builder. Produces the plain-text policy served at
// /.well-known/security.txt so researchers can find the disclosure contact. `Expires` is computed
// relative to the request time so a running deployment never serves an expired file. Contact and
// policy URL are overridable via env; both have sensible project defaults.

/** Days until the served `security.txt` expires (RFC 9116 recommends well under a year). */
export const SECURITY_TXT_EXPIRY_DAYS = 180 as const;

const DAY_MS = 86_400_000;

/** Default disclosure contact (overridable via `FACET_SECURITY_CONTACT`). */
export const DEFAULT_SECURITY_CONTACT = 'mailto:security@writerslogic.com';

/** Default policy URL (overridable via `FACET_SECURITY_POLICY`). */
export const DEFAULT_SECURITY_POLICY =
	'https://github.com/writerslogic/facet/blob/main/SECURITY.md';

export interface SecurityTxtInput {
	/** Deployment origin, e.g. `https://analytics.example.com`, used for the Canonical URL. */
	origin: string;
	/** Contact URI (mailto:/https:). Defaults to {@link DEFAULT_SECURITY_CONTACT}. */
	contact?: string;
	/** Security-policy URL. Defaults to {@link DEFAULT_SECURITY_POLICY}. */
	policy?: string;
	/** Wall-clock time in ms, used to compute a future `Expires`. */
	now: number;
}

/** Build an RFC 9116 `security.txt` body (Contact + Expires required; Canonical/Policy recommended). */
export function buildSecurityTxt(input: SecurityTxtInput): string {
	const contact = input.contact || DEFAULT_SECURITY_CONTACT;
	const policy = input.policy || DEFAULT_SECURITY_POLICY;
	const expires = new Date(input.now + SECURITY_TXT_EXPIRY_DAYS * DAY_MS).toISOString();
	return [
		'# Security contact for this Facet deployment. See https://github.com/writerslogic/facet',
		`Contact: ${contact}`,
		`Expires: ${expires}`,
		`Canonical: ${input.origin}/.well-known/security.txt`,
		`Policy: ${policy}`,
		'Preferred-Languages: en',
		'',
	].join('\n');
}
