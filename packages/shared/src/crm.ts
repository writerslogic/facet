// Wire schemas for the optional CRM extension — contacts (people) and companies (the organizations
// they belong to). Every bound here is a real limit on stored PII, not a formality: the contact
// fields are the first directly-identifying data the deployment holds, and the column widths are what
// stop a "notes" field becoming an unbounded free-text dossier.
//
// `site_id` is NOT in any of these bodies. It always comes from the `?site_id=` query parameter that
// the session/RBAC guard authorized, exactly as the consent routes take it from the API key — a body
// field would let a caller with a role on one site write into another.

import * as v from 'valibot';

/** Contact lifecycle. A closed set so the list filter means something. */
export const ContactStatusSchema = v.picklist(['lead', 'active', 'archived']);

/** Company lifecycle. The same closed set, and the reason it exists is that deleting a company that
 * still has contacts is a destructive answer to "we stopped working with them"; archiving is not. */
export const CompanyStatusSchema = v.picklist(['lead', 'active', 'archived']);

export const CONTACT_NOTES_MAX_LEN = 4000;

/** Optional, bounded, trimmable text. `''` is accepted and normalised to NULL by the data layer,
 * because a form that submits every field always sends empty strings for the untouched ones. */
const optionalText = (max: number) => v.optional(v.pipe(v.string(), v.maxLength(max)));

const contactFields = {
	/** The site's own opaque id for this person — the join key to `consent_records.external_user_id`
	 * and the only thing that can ever link this contact to analytics. Same bound as the `user_id`
	 * accepted by /api/consent and /api/event, because it must be the identical value. */
	external_user_id: optionalText(256),
	email: v.optional(v.pipe(v.string(), v.maxLength(254))),
	name: optionalText(200),
	phone: optionalText(40),
	company: optionalText(200),
	/** The structured link to a `companies` row on the same site. Same fact as `company`, recorded the
	 * other way: setting either clears the other, so a contact never carries two employers. Supplying
	 * both as non-empty in one request is a contradiction and is rejected rather than silently
	 * resolved in favour of one. */
	company_id: optionalText(64),
	title: optionalText(200),
	status: v.optional(ContactStatusSchema),
	source: optionalText(100),
	notes: optionalText(CONTACT_NOTES_MAX_LEN),
	/** A dashboard operator (`users.id` in the ANALYTICS database) who owns this record. Validated
	 * against `users` in the Worker — D1 cannot express a cross-database foreign key. */
	owner_user_id: optionalText(64),
};

/**
 * Email must actually be an email when present — it is the natural dedupe key and the unique index
 * is built on it. This is a `check` rather than an `v.email()` in the field's own pipe because `''`
 * has to stay acceptable: a form that submits every field sends empty strings for the untouched
 * ones, and `v.email()` would reject those as malformed instead of reading them as "not supplied".
 * The data layer normalises `''` to NULL, which is also what keeps blank emails from colliding.
 */
const ContactFieldsSchema = v.object(contactFields);

const EmailSchema = v.pipe(v.string(), v.email());

const emailIsWellFormed = v.check(
	(b: v.InferOutput<typeof ContactFieldsSchema>) =>
		!b.email?.trim() || v.safeParse(EmailSchema, b.email).success,
	'invalid_email',
);

/** `company` and `company_id` are one fact recorded two ways. Supplying both as non-empty asks for
 * two employers at once, and picking a winner silently would discard whichever the caller meant. */
const companyIsUnambiguous = v.check(
	(b: v.InferOutput<typeof ContactFieldsSchema>) => !(b.company?.trim() && b.company_id?.trim()),
	'company_conflict',
);

/** Create a contact. Requires at least one identifier: a row with no email, no external id and no
 * name is not a contact, it is an empty row that can never be matched, deduped, or erased on
 * request. */
export const ContactCreateSchema = v.pipe(
	ContactFieldsSchema,
	emailIsWellFormed,
	companyIsUnambiguous,
	v.check(
		(b) => Boolean(b.email?.trim() || b.external_user_id?.trim() || b.name?.trim()),
		'contact_needs_an_identifier',
	),
);

/** Partial update. Every field is optional and only the keys actually present are written, so a
 * PATCH that omits `notes` leaves the notes alone rather than clearing them. */
export const ContactUpdateSchema = v.pipe(
	ContactFieldsSchema,
	emailIsWellFormed,
	companyIsUnambiguous,
);

/** Bounds on a CRM list page, declared once and shared by contacts and companies. The contact list
 * carries PII, so the ceiling is not the caller's to choose — and the schemas below are the only
 * thing enforcing it, so the server imports these rather than repeating the numbers next to a second
 * copy that can drift. */
export const CRM_MAX_PAGE = 100;

/** How deep a CRM list may be paged. */
export const CRM_MAX_OFFSET = 100_000;
export const CRM_DEFAULT_PAGE = 25;

const pageBounds = {
	limit: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(CRM_MAX_PAGE),
		),
	),
	/** Bounded at both ends. SQLite walks every skipped row, so an unbounded `offset` is a full
	 * table scan and the natural shape of a page-by-page bulk read of the whole contact list. */
	offset: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.integer(),
			v.minValue(0),
			v.maxValue(CRM_MAX_OFFSET),
		),
	),
};

/** Query for `GET /api/crm/contacts`. `q` is a bounded substring search over name/email/company. */
export const ContactListQuerySchema = v.object({
	status: v.optional(ContactStatusSchema),
	q: v.optional(v.pipe(v.string(), v.maxLength(100))),
	...pageBounds,
});

/** Longest legal DNS name — the bound on the STORED value. The domain is a dedupe key, so its shape
 * is enforced rather than trusted. */
export const COMPANY_DOMAIN_MAX_LEN = 253;

/** The bound on what may be SUBMITTED, which is deliberately looser: an operator pastes a URL, and
 * `https://acme.com/<a long path>?utm=...` normalises to a short host but arrives long. Rejecting it
 * on raw length would fail the input this field exists to accept. */
const COMPANY_DOMAIN_INPUT_MAX_LEN = 2048;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The stored form of a company domain: lowercased, with the scheme, any path, any port and a
 * trailing dot removed, so `https://Acme.com/about` and `acme.com` are the same company rather than
 * two. Exported because the wire schema and the data layer must agree on it exactly — if the schema
 * validated the raw string and the data layer stored something else, the unique index would be
 * enforced over a value nothing had checked.
 *
 * `www.` is deliberately NOT stripped: it is a different host, and deciding it is the same
 * organization is a guess this has no business making on the operator's behalf.
 */
export function normalizeCompanyDomain(raw: string | null | undefined): string | null {
	const trimmed = raw?.trim().toLowerCase();
	if (!trimmed) return null;
	const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
	const host = withoutScheme.split(/[/?#]/)[0]?.split('@').pop()?.split(':')[0] ?? '';
	const bare = host.replace(/\.$/, '');
	return bare ? bare : null;
}

const companyFields = {
	name: optionalText(200),
	domain: optionalText(COMPANY_DOMAIN_INPUT_MAX_LEN),
	status: v.optional(CompanyStatusSchema),
	notes: optionalText(CONTACT_NOTES_MAX_LEN),
	/** Same cross-database validation as a contact's owner: checked against `users` in the Worker. */
	owner_user_id: optionalText(64),
};

const CompanyFieldsSchema = v.object(companyFields);

const domainIsWellFormed = v.check((b: v.InferOutput<typeof CompanyFieldsSchema>) => {
	if (!b.domain?.trim()) return true;
	const normalized = normalizeCompanyDomain(b.domain);
	return Boolean(
		normalized && normalized.length <= COMPANY_DOMAIN_MAX_LEN && HOSTNAME.test(normalized),
	);
}, 'invalid_domain');

/** Create a company. The name is required and is the display value — a company with no name cannot
 * be picked out of a list, and `companies.name` is NOT NULL. */
export const CompanyCreateSchema = v.pipe(
	CompanyFieldsSchema,
	domainIsWellFormed,
	v.check((b) => Boolean(b.name?.trim()), 'company_needs_a_name'),
);

/** Partial update. `name` may be omitted, but a `name` that is present must still be a name: the
 * column is NOT NULL and blanking it would leave a row nothing can refer to. */
export const CompanyUpdateSchema = v.pipe(
	CompanyFieldsSchema,
	domainIsWellFormed,
	v.check((b) => !('name' in b) || Boolean(b.name?.trim()), 'company_needs_a_name'),
);

/** Query for `GET /api/crm/companies`. `q` is a bounded substring search over name/domain. */
export const CompanyListQuerySchema = v.object({
	status: v.optional(CompanyStatusSchema),
	q: v.optional(v.pipe(v.string(), v.maxLength(100))),
	...pageBounds,
});

/** Query for `GET /api/crm/companies/:id/contacts` — the same page bounds, no independent filter. */
export const CompanyContactsQuerySchema = v.object(pageBounds);

/** Deal lifecycle. `won`/`lost` are terminal; a pipeline total treats every other stage as open. */
export const DealStageSchema = v.picklist([
	'lead',
	'qualified',
	'proposal',
	'negotiation',
	'won',
	'lost',
]);

export const DEAL_NOTES_MAX_LEN = 4000;

const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/** Three-letter ISO 4217 code, uppercased on the wire so `USD` and `usd` are the same currency rather
 * than two buckets in a pipeline total.
 *
 * IMPORTANT: checked on the alphabet, and after the uppercase. A bare `length(3)` over the raw string
 * accepted `'   '`, which the data layer's blank-to-NULL rule then stored as a priced deal with no
 * currency — the one state `moneyIsPaired` exists to forbid, and one the pipeline summary drops
 * outright. It also accepted `'ßab'`, whose uppercase is four characters long. */
const CurrencySchema = v.pipe(
	v.string(),
	v.toUpperCase(),
	v.regex(/^[A-Z]{3}$/, 'invalid_currency'),
);

const dealFields = {
	name: v.pipe(v.string(), v.maxLength(200)),
	company_id: optionalText(64),
	contact_id: optionalText(64),
	stage: v.optional(DealStageSchema),
	/** Cents. Whole dollars/pounds/etc times 100, matching how every other money amount in this
	 * ecosystem (Stripe, DEVPLAN's planned ecommerce tracking) avoids float rounding. Capped where
	 * that stops being true: past 2^53 a JS integer no longer round-trips, so an unbounded `value`
	 * would put a lossy float into the column the pipeline SUMs. */
	value: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SAFE_INT_MAX))),
	currency: v.optional(CurrencySchema),
	/** Unix ms, matching every other timestamp on the wire. */
	expected_close_date: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SAFE_INT_MAX)),
	),
	notes: optionalText(DEAL_NOTES_MAX_LEN),
	owner_user_id: optionalText(64),
};

const DealFieldsSchema = v.object(dealFields);

/** `value` and `currency` are one fact recorded in two columns — a value with no currency cannot be
 * summed into a pipeline total, and a currency with no value names nothing. Shared by create and
 * update so the two can never drift on what "paired" means. */
function moneyIsPaired<T extends { value?: number; currency?: string }>(b: T): boolean {
	// `Boolean(b.value)` would reject `value: 0` as absent — 0 is a valid deal amount (see `dealFields`
	// above), so presence must be checked against `undefined`, not truthiness.
	return (b.value !== undefined) === (b.currency !== undefined);
}

/** Create a deal. The name is required and is the display value, matching `CompanyCreateSchema`. */
export const DealCreateSchema = v.pipe(
	DealFieldsSchema,
	v.check((b) => Boolean(b.name.trim()), 'deal_needs_a_name'),
	v.check(moneyIsPaired, 'deal_value_needs_currency'),
);

/** Partial update. `name` may be omitted, but a present `name` must still be non-blank — the column is
 * NOT NULL and blanking it would leave a row nothing can refer to. */
export const DealUpdateSchema = v.pipe(
	v.object({ ...dealFields, name: v.optional(dealFields.name) }),
	v.check((b) => !('name' in b) || Boolean(b.name?.trim()), 'deal_needs_a_name'),
	v.check(moneyIsPaired, 'deal_value_needs_currency'),
);

/** Query for `GET /api/crm/deals`. `q` is a bounded substring search over the deal name. */
export const DealListQuerySchema = v.object({
	stage: v.optional(DealStageSchema),
	company_id: optionalText(64),
	contact_id: optionalText(64),
	q: v.optional(v.pipe(v.string(), v.maxLength(100))),
	...pageBounds,
});

/**
 * Every action the CRM audit log records — one per route, and the closed set is the point.
 *
 * A free-form action string would make the log filterable only by whatever spelling each handler
 * happened to use, and "was this contact exported?" has to be answerable by equality rather than by
 * guessing at synonyms. The names are `<subject>.<verb>` so a prefix filter reads as "everything
 * anyone did to contacts".
 *
 * `audit.read` is in the set because reading the log is itself an access worth recording: it names
 * which operator looked at which contact, so it is the one route whose readers a deployment most
 * wants to know.
 */
export const CRM_AUDIT_ACTIONS = [
	'contact.list',
	'contact.create',
	'contact.read',
	'contact.update',
	'contact.delete',
	'contact.analytics',
	'contact.export',
	'company.list',
	'company.create',
	'company.read',
	'company.update',
	'company.delete',
	'company.contacts',
	'company.analytics',
	'deal.list',
	'deal.create',
	'deal.read',
	'deal.update',
	'deal.delete',
	'deal.pipeline',
	'audit.read',
] as const;

export const CrmAuditActionSchema = v.picklist(CRM_AUDIT_ACTIONS);

/** Query for `GET /api/crm/audit`. Every filter is an exact match on a recorded column — there is no
 * substring search, because the log holds ids and action names rather than anything a person would
 * search for by fragment. */
export const CrmAuditListQuerySchema = v.object({
	action: v.optional(CrmAuditActionSchema),
	actor_user_id: optionalText(64),
	target_id: optionalText(64),
	...pageBounds,
});

export type ContactStatus = v.InferOutput<typeof ContactStatusSchema>;
export type ContactCreateInput = v.InferOutput<typeof ContactCreateSchema>;
export type ContactUpdateInput = v.InferOutput<typeof ContactUpdateSchema>;
export type ContactListQueryInput = v.InferOutput<typeof ContactListQuerySchema>;
export type CompanyStatus = v.InferOutput<typeof CompanyStatusSchema>;
export type CompanyCreateInput = v.InferOutput<typeof CompanyCreateSchema>;
export type CompanyUpdateInput = v.InferOutput<typeof CompanyUpdateSchema>;
export type CompanyListQueryInput = v.InferOutput<typeof CompanyListQuerySchema>;
export type DealStage = v.InferOutput<typeof DealStageSchema>;
export type DealCreateInput = v.InferOutput<typeof DealCreateSchema>;
export type DealUpdateInput = v.InferOutput<typeof DealUpdateSchema>;
export type DealListQueryInput = v.InferOutput<typeof DealListQuerySchema>;
export type CrmAuditAction = v.InferOutput<typeof CrmAuditActionSchema>;
export type CrmAuditListQueryInput = v.InferOutput<typeof CrmAuditListQuerySchema>;
