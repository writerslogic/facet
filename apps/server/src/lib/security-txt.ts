// RFC 9116 `security.txt` builder. Produces the plain-text policy served at
// /.well-known/security.txt so researchers can find the disclosure contact. `Expires` is computed
// relative to the request time so a running deployment never serves an expired file.
//
// WHY there are no project defaults here: a security.txt is a claim made BY THE OPERATOR of the
// host it is served from — "report vulnerabilities in THIS deployment to this address". A vendor
// default would make every self-hoster who never set the env var publish the upstream maintainer's
// mailbox as their own disclosure address, and RFC 9116 gives a reader no way to tell a shipped
// default from a deliberate choice. So this builder emits only values the operator supplied plus
// request-derived facts (Canonical, Expires); the route serves nothing at all until
// `FACET_SECURITY_CONTACT` is set (see routes/wellknown.ts). Publishing no security.txt is a valid,
// honest state — most hosts publish none — whereas publishing someone else's contact is not.

/** Days until the served `security.txt` expires (RFC 9116 recommends well under a year). */
export const SECURITY_TXT_EXPIRY_DAYS = 180 as const;

const DAY_MS = 86_400_000;

export interface SecurityTxtInput {
	/** Deployment origin, e.g. `https://analytics.example.com`, used for the Canonical URL. */
	origin: string;
	/** Operator-supplied contact URI (mailto:/https:). Required — RFC 9116 has no valid file
	 * without `Contact`, and only the operator can say who receives reports about their host. */
	contact: string;
	/** Operator-supplied security-policy URL. Emitted only when set; `Policy` is optional in
	 * RFC 9116, and pointing it at the upstream project would assert a policy the operator has
	 * not adopted (and route reports away from them). */
	policy?: string;
	/** Wall-clock time in ms, used to compute a future `Expires`. */
	now: number;
}

/** Build an RFC 9116 `security.txt` body (Contact + Expires required; Canonical/Policy recommended). */
export function buildSecurityTxt(input: SecurityTxtInput): string {
	const expires = new Date(input.now + SECURITY_TXT_EXPIRY_DAYS * DAY_MS).toISOString();
	const lines = [
		'# Security contact for this deployment, published by its operator.',
		// AGPL-3.0 asks a network deployment to point users at its source; a researcher landing here
		// also benefits from knowing which software (and which version line) they are looking at.
		'# Software: Facet — https://github.com/writerslogic/facet',
		`Contact: ${input.contact}`,
		`Expires: ${expires}`,
		`Canonical: ${input.origin}/.well-known/security.txt`,
	];
	if (input.policy) lines.push(`Policy: ${input.policy}`);
	lines.push('Preferred-Languages: en', '');
	return lines.join('\n');
}
