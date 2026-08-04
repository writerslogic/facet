// Wire schemas for the optional CRM extension. Every bound here is a real limit on stored PII, not a
// formality: these fields are the first directly-identifying data the deployment holds, and the
// column widths are what stop a "notes" field becoming an unbounded free-text dossier.
//
// `site_id` is NOT in any of these bodies. It always comes from the `?site_id=` query parameter that
// the session/RBAC guard authorized, exactly as the consent routes take it from the API key — a body
// field would let a caller with a role on one site write into another.

import * as v from 'valibot';

/** Contact lifecycle. A closed set so the list filter means something. */
export const ContactStatusSchema = v.picklist(['lead', 'active', 'archived']);

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

const emailIsWellFormed = v.check(
	(b: v.InferOutput<typeof ContactFieldsSchema>) =>
		!b.email?.trim() || v.safeParse(v.pipe(v.string(), v.email()), b.email).success,
	'invalid_email',
);

/** Create a contact. Requires at least one identifier: a row with no email, no external id and no
 * name is not a contact, it is an empty row that can never be matched, deduped, or erased on
 * request. */
export const ContactCreateSchema = v.pipe(
	ContactFieldsSchema,
	emailIsWellFormed,
	v.check(
		(b) => Boolean(b.email?.trim() || b.external_user_id?.trim() || b.name?.trim()),
		'contact_needs_an_identifier',
	),
);

/** Partial update. Every field is optional and only the keys actually present are written, so a
 * PATCH that omits `notes` leaves the notes alone rather than clearing them. */
export const ContactUpdateSchema = v.pipe(ContactFieldsSchema, emailIsWellFormed);

/** Bounds on a contact list page, declared once. The list carries PII, so the ceiling is not the
 * caller's to choose — and the schema below is the only thing enforcing it, so the server imports
 * these rather than repeating the numbers next to a second copy that can drift. */
export const CONTACTS_MAX_PAGE = 100;
export const CONTACTS_DEFAULT_PAGE = 25;

/** Query for `GET /api/crm/contacts`. `q` is a bounded substring search over name/email/company. */
export const ContactListQuerySchema = v.object({
	status: v.optional(ContactStatusSchema),
	q: v.optional(v.pipe(v.string(), v.maxLength(100))),
	limit: v.optional(
		v.pipe(
			v.string(),
			v.transform(Number),
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(CONTACTS_MAX_PAGE),
		),
	),
	offset: v.optional(
		v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
	),
});

export type ContactStatus = v.InferOutput<typeof ContactStatusSchema>;
export type ContactCreateInput = v.InferOutput<typeof ContactCreateSchema>;
export type ContactUpdateInput = v.InferOutput<typeof ContactUpdateSchema>;
export type ContactListQueryInput = v.InferOutput<typeof ContactListQuerySchema>;
