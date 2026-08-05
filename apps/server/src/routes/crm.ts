// CRM endpoints — the optional contacts-and-companies extension. Two gates apply to every route
// here, in order.
//
// 1. THE BINDING. No `CRM_DB` means this deployment has no CRM database: 501 `crm_unavailable`,
//    before authentication, uniformly, including for paths that do not exist. The router-wide guard
//    is safe here (unlike adminRoutes) because /api/crm is its own mount path and shares it with
//    nothing public.
//
// 2. THE SESSION. Contact PII is behind an operator session with a team role, and NOTHING here
//    accepts an API key. That is the one deliberate departure from every other authenticated route
//    in this codebase, and it is deliberate because a `clk_` key is not a secret in the way a
//    session is: /llms.txt tells agents where to send one, and a public demo dashboard can ship with
//    one compiled in. A key that leaks costs you aggregate pageview counts. A key that could read
//    /api/crm/contacts would cost you your customers' names, emails and phone numbers.
//
//    Roles: `analyst` reads and edits contacts and companies; `admin` is required to DELETE either
//    or to export a contact. Those are the irreversible and the bulk-disclosure operations, and
//    `viewer` — who can see aggregate analytics — has no CRM access at all, because PII is a
//    different kind of access, not more of the same one.
//
// The contact→analytics link (`GET /contacts/:id/analytics`) never queries events by anything a
// contact row controls. It resolves `external_user_id` through `findLinkedVisitorHashes`, which
// returns hashes only from consent statements that verify against the deployment key — so a contact
// with no active consent is simply not connected to any analytics, and there is no code path that
// could make it so.
//
// The company rollup (`GET /companies/:id/analytics`) is that same gate applied per contact and
// summed, never a query over "the company". See the handler for why it carries no k-anonymity floor
// and why it reports two contact counts rather than one.

import {
	CRM_DEFAULT_PAGE,
	CompanyContactsQuerySchema,
	CompanyCreateSchema,
	CompanyListQuerySchema,
	CompanyUpdateSchema,
	ContactCreateSchema,
	ContactListQuerySchema,
	ContactUpdateSchema,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
	COMPANY_ROLLUP_MAX_CONTACTS,
	CONTACT_EXPORT_MAX_EVENTS,
	contactActivity,
	contactConsentRecords,
	contactEvents,
} from '../db/contact-analytics.js';
import {
	type Company,
	type Contact,
	companyContactLinkage,
	deleteCompany,
	deleteContact,
	foreignKeyViolation,
	getCompany,
	getContact,
	insertCompany,
	insertContact,
	listCompanies,
	listCompanyContacts,
	listContacts,
	requireCrm,
	requireCrmDb,
	uniqueConstraintText,
	updateCompany,
	updateContact,
} from '../db/crm.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv, Env } from '../env.js';
import { requireTeamRole } from '../lib/auth.js';
import {
	eraseConsentByExternalUserId,
	findLinkedVisitorHashes,
	findLinkedVisitorHashesForMany,
} from '../lib/consent.js';
import { CRM_MAX_BODY_BYTES } from '../lib/constants.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';

export const crmRoutes = new Hono<AppEnv>();

crmRoutes.use('*', requireCrm);

// The global body limit is path-scoped to /api/collect, so it never reached here — leaving the one
// route group that stores personal data as the only one accepting an unbounded upload.
crmRoutes.use(
	'*',
	bodyLimit({
		maxSize: CRM_MAX_BODY_BYTES,
		onError: () => {
			throw new ApiError('payload_too_large', 413);
		},
	}),
);

/**
 * Rate limit, keyed by the OPERATOR rather than the site.
 *
 * Everything else in this codebase keys its bucket per site, because the risk it manages is one
 * tenant's traffic drowning another's. The risk here is different: these are the only routes that
 * return names, emails and phone numbers, and the threat is a single stolen session pulling the whole
 * table a page at a time. Keying per site would let a compromised operator hide inside their team's
 * legitimate traffic and would punish their colleagues for it; keying per operator caps the session
 * that is actually doing it.
 *
 * Applied AFTER the role guard at every call site, matching /api/event: an unauthenticated request is
 * rejected before it can consume anyone's bucket, and `userId` is only set once a session resolves.
 */
const crmRateLimit = rateLimit((c) => `crm:${c.get('userId') ?? 'unauthenticated'}`);

/** Resolve a contact or raise the canonical 404. Scoped by the authorized site, so a contact id from
 * another site is indistinguishable from one that does not exist. */
async function loadContact(env: Env, siteId: string, id: string): Promise<Contact> {
	const contact = await getContact(requireCrmDb(env), siteId, id);
	if (!contact) {
		throw new ApiError('not_found', 404);
	}
	return contact;
}

/** Reject an `owner_user_id` that is not a real dashboard operator. D1 cannot enforce this as a
 * foreign key across the database boundary, so it is enforced here — otherwise the column quietly
 * accumulates ids that resolve to nobody and "who owns this contact" stops being answerable. */
async function assertOwnerExists(env: Env, ownerUserId: string | undefined): Promise<void> {
	const id = ownerUserId?.trim();
	if (!id) return;
	const user = await db(env)
		.select({ id: schema.users.id })
		.from(schema.users)
		.where(eq(schema.users.id, id))
		.get();
	if (!user) {
		throw new ApiError('unknown_owner', 400, 'owner_user_id does not match a known user');
	}
}

/**
 * Map a failed contact write onto the status it deserves, or rethrow.
 *
 * The unique indexes on `(site_id, email)` and `(site_id, external_user_id)` are the dedupe, and
 * naming the field that collided is safe: the caller holds a role on this site and submitted the
 * value themselves. A foreign-key failure means the company was deleted between this request
 * resolving it and writing the row — the caller lost a race, which is a 400 about their `company_id`
 * and not a 500 about the server.
 */
function contactWriteError(err: unknown): never {
	const conflict = uniqueConstraintText(err);
	if (conflict) {
		throw new ApiError(
			'contact_exists',
			409,
			/external_user_id/i.test(conflict)
				? 'a contact with this external_user_id already exists'
				: 'a contact with this email already exists',
		);
	}
	if (foreignKeyViolation(err)) {
		throw new ApiError(
			'unknown_company',
			400,
			'company_id does not match a company on this site',
		);
	}
	throw err;
}

/** A contact's currently-authorized visitor hashes, or [] when nothing authorizes a link. */
function linkedHashes(
	env: Env,
	requestUrl: string,
	siteId: string,
	contact: Contact,
): Promise<string[]> {
	if (!contact.external_user_id) return Promise.resolve([]);
	return findLinkedVisitorHashes(env, new URL(requestUrl), {
		siteId,
		externalUserId: contact.external_user_id,
		now: Date.now(),
	});
}

/**
 * Every list response carries the role it was served under.
 *
 * A client has no other way to learn it. `GET /api/auth/me` reports a role per TEAM, and no
 * session-reachable route maps a site to its owning team — that lives behind the admin token — so a
 * browser deciding whether to offer the admin-only Delete and Export could only guess. Guessing high
 * offers a button that answers 403; guessing low hides one the operator is entitled to. The server
 * already resolved the exact role to authorize this very request, so it says so.
 */
crmRoutes.get(
	'/contacts',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('query', ContactListQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const { contacts, total } = await listContacts(requireCrmDb(c.env), c.get('siteId'), {
			status: query.status,
			q: query.q,
			limit: query.limit ?? CRM_DEFAULT_PAGE,
			offset: query.offset ?? 0,
		});
		return c.json({ contacts, total, role: c.get('role') });
	},
);

crmRoutes.post(
	'/contacts',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('json', ContactCreateSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		await assertOwnerExists(c.env, body.owner_user_id);
		// site_id comes from the guard's authorized query parameter, NEVER the body.
		const contact = await insertContact(
			requireCrmDb(c.env),
			c.get('siteId'),
			body,
			Date.now(),
		).catch(contactWriteError);
		return c.json({ contact }, 201);
	},
);

crmRoutes.get('/contacts/:id', requireTeamRole('analyst'), crmRateLimit, async (c) => {
	const contact = await loadContact(c.env, c.get('siteId'), c.req.param('id'));
	return c.json({ contact });
});

crmRoutes.patch(
	'/contacts/:id',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('json', ContactUpdateSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		await assertOwnerExists(c.env, body.owner_user_id);
		const contact = await updateContact(
			requireCrmDb(c.env),
			c.get('siteId'),
			c.req.param('id') ?? '',
			body,
			Date.now(),
		).catch(contactWriteError);
		if (!contact) {
			throw new ApiError('not_found', 404);
		}
		return c.json({ contact });
	},
);

/**
 * Erase a contact. The row is DELETEd — there is no tombstone, because a tombstone that still holds
 * an email is still that person's personal data and cannot answer an erasure request.
 *
 * It also erases their consent records, and that is not a side effect but the point: leaving them
 * would leave rows holding the raw `external_user_id` this contact was erased by, and would leave a
 * live grant elevating a person who is no longer in the system. Note this ERASES rather than revokes
 * for the same reason. The analytics events themselves stay — they are already pseudonymous rows
 * keyed by a salted hash, and with the consent record gone nothing can ever re-associate them with a
 * person; destroying the link is what erasure of the identifiable data means here.
 */
crmRoutes.delete('/contacts/:id', requireTeamRole('admin'), crmRateLimit, async (c) => {
	const siteId = c.get('siteId');
	const contact = await loadContact(c.env, siteId, c.req.param('id') ?? '');
	// The two writes land in DIFFERENT databases and D1 has no transaction spanning them, so one of
	// them can be left undone. The order decides which. Erasing the consent records FIRST means a
	// failure leaves the contact row still present and still naming the uid — an erasure that can
	// simply be retried. Deleting the contact first would mean a failure destroys the only record of
	// which uid to erase, stranding rows that hold that person's raw identifier: exactly the data the
	// request was about, now unreachable by any retry.
	const consentErased = contact.external_user_id
		? await eraseConsentByExternalUserId(c.env, {
				siteId,
				externalUserId: contact.external_user_id,
			})
		: 0;
	const deleted = await deleteContact(requireCrmDb(c.env), siteId, contact.id);
	if (!deleted) {
		// Lost a race with a concurrent delete, which already erased the same consent rows.
		throw new ApiError('not_found', 404);
	}
	return c.json({ deleted: true, consent_records_erased: consentErased });
});

/** A contact's analytics, if and only if an active signed consent record authorizes the link. When
 * it does not, the response says so explicitly rather than returning zeroes that read like "this
 * person did nothing" — `linked: false` and a reason are the honest answer. */
crmRoutes.get('/contacts/:id/analytics', requireTeamRole('analyst'), crmRateLimit, async (c) => {
	const siteId = c.get('siteId');
	const contact = await loadContact(c.env, siteId, c.req.param('id'));
	if (!contact.external_user_id) {
		return c.json({ linked: false, reason: 'no_external_user_id' });
	}
	const hashes = await linkedHashes(c.env, c.req.url, siteId, contact);
	if (hashes.length === 0) {
		return c.json({ linked: false, reason: 'no_active_consent' });
	}
	return c.json({
		linked: true,
		// One hash per salt window with a live grant — i.e. how far back the linkage currently
		// reaches. It shrinks on its own as retention purges the older consent records.
		windows: hashes.length,
		activity: await contactActivity(c.env, siteId, hashes),
	});
});

/**
 * Data-subject export for one contact: everything this deployment holds about that person, in one
 * document. `admin` only — it is the single request that discloses the most about one individual.
 *
 * The `consent` section carries the signed statements verbatim. They are PII-free by construction
 * (their claims are a derived hash, a tier and a window), so including them adds cryptographic
 * evidence of what was consented to without widening what the export reveals.
 */
crmRoutes.get('/contacts/:id/export', requireTeamRole('admin'), crmRateLimit, async (c) => {
	const siteId = c.get('siteId');
	const contact = await loadContact(c.env, siteId, c.req.param('id'));
	const externalUserId = contact.external_user_id;
	const hashes = await linkedHashes(c.env, c.req.url, siteId, contact);
	const [activity, events, consent] = await Promise.all([
		contactActivity(c.env, siteId, hashes),
		contactEvents(c.env, siteId, hashes),
		externalUserId ? contactConsentRecords(c.env, siteId, externalUserId) : Promise.resolve([]),
	]);
	return c.json({
		exported_at: new Date().toISOString(),
		contact,
		consent,
		analytics: {
			linked: hashes.length > 0,
			windows: hashes.length,
			activity,
			events,
			// Never a silent cap: an export that returned a prefix without saying so would read as
			// the complete record and answer a subject-access request incorrectly. Compared against
			// `total`, NOT `events` — the latter counts custom events only, so a contact whose
			// traffic is all pageviews would report `false` while a thousand rows were dropped.
			events_truncated: activity.total > events.length,
			events_limit: CONTACT_EXPORT_MAX_EVENTS,
		},
	});
});

/** Resolve a company or raise the canonical 404, scoped by the authorized site exactly as contacts
 * are — a company id from another site is indistinguishable from one that does not exist. */
async function loadCompany(env: Env, siteId: string, id: string): Promise<Company> {
	const company = await getCompany(requireCrmDb(env), siteId, id);
	if (!company) {
		throw new ApiError('not_found', 404);
	}
	return company;
}

/** Map a company unique-constraint violation onto the field that actually collided. Safe to name for
 * the same reason it is on contacts: the caller holds a role on this site and submitted the value. */
function companyConflict(err: unknown): never {
	const conflict = uniqueConstraintText(err);
	if (conflict) {
		throw new ApiError(
			'company_exists',
			409,
			/domain/i.test(conflict)
				? 'a company with this domain already exists'
				: 'a company with this name already exists',
		);
	}
	throw err;
}

crmRoutes.get(
	'/companies',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('query', CompanyListQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const { companies, total } = await listCompanies(requireCrmDb(c.env), c.get('siteId'), {
			status: query.status,
			q: query.q,
			limit: query.limit ?? CRM_DEFAULT_PAGE,
			offset: query.offset ?? 0,
		});
		return c.json({ companies, total, role: c.get('role') });
	},
);

crmRoutes.post(
	'/companies',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('json', CompanyCreateSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		await assertOwnerExists(c.env, body.owner_user_id);
		// site_id comes from the guard's authorized query parameter, NEVER the body.
		const company = await insertCompany(
			requireCrmDb(c.env),
			c.get('siteId'),
			body,
			Date.now(),
		).catch(companyConflict);
		return c.json({ company }, 201);
	},
);

crmRoutes.get('/companies/:id', requireTeamRole('analyst'), crmRateLimit, async (c) => {
	const company = await loadCompany(c.env, c.get('siteId'), c.req.param('id'));
	return c.json({ company });
});

crmRoutes.patch(
	'/companies/:id',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('json', CompanyUpdateSchema, validationErrorHook),
	async (c) => {
		const body = c.req.valid('json');
		await assertOwnerExists(c.env, body.owner_user_id);
		const company = await updateCompany(
			requireCrmDb(c.env),
			c.get('siteId'),
			c.req.param('id') ?? '',
			body,
			Date.now(),
		).catch(companyConflict);
		if (!company) {
			throw new ApiError('not_found', 404);
		}
		return c.json({ company });
	},
);

/**
 * Delete a company. Its contacts survive — deleting an organization is not an erasure request about
 * the people in it, and a person's record has its own lifecycle and its own DELETE. Each contact's
 * `company_id` is cleared and the company's name is written back into their free-text `company`, so
 * "where does this person work" answers the same before and after; only the structured link is gone.
 *
 * `admin` rather than `analyst` because it is irreversible and it rewrites rows the caller did not
 * name — the same reason deleting a contact is.
 */
crmRoutes.delete('/companies/:id', requireTeamRole('admin'), crmRateLimit, async (c) => {
	const result = await deleteCompany(requireCrmDb(c.env), c.get('siteId'), c.req.param('id'));
	if (!result) {
		throw new ApiError('not_found', 404);
	}
	return c.json({ deleted: true, contacts_unlinked: result.contacts_unlinked });
});

crmRoutes.get(
	'/companies/:id/contacts',
	requireTeamRole('analyst'),
	crmRateLimit,
	vValidator('query', CompanyContactsQuerySchema, validationErrorHook),
	async (c) => {
		const siteId = c.get('siteId');
		const company = await loadCompany(c.env, siteId, c.req.param('id') ?? '');
		const query = c.req.valid('query');
		const { contacts, total } = await listCompanyContacts(
			requireCrmDb(c.env),
			siteId,
			company.id,
			{ limit: query.limit ?? CRM_DEFAULT_PAGE, offset: query.offset ?? 0 },
		);
		return c.json({ contacts, total, role: c.get('role') });
	},
);

/**
 * A company's analytics: the sum over its contacts, each one still individually consent-gated.
 *
 * WHY THIS DISCLOSES NOTHING NEW. Every hash summed here came out of `findLinkedVisitorHashesForMany`
 * — the same verified-statement gate the per-contact route uses, applied per contact. A contact with
 * no active signed consent contributes nothing, so the aggregate is exactly the union of the
 * individual results the SAME caller can already fetch one at a time, attributed, from
 * `/contacts/:id/analytics`. It is strictly less revealing than the calls it replaces.
 *
 * WHY THERE IS NO K-ANONYMITY FLOOR, despite `K_ANON` existing for the analytics breakdowns. That
 * floor protects visitors who the operator has no other route to: suppressing a value seen by fewer
 * than three people is what stops a breakdown singling one out. Here the subjects are contacts whose
 * data this caller can already retrieve individually and by name. A floor would suppress a
 * two-contact company's rollup while both of their pages stayed readable — hiding a legitimate answer
 * while protecting nobody. Applying it would be cargo cult, not privacy.
 *
 * WHAT DOES NEED SAYING is the denominator. "142 pageviews" for a twelve-person account reads as the
 * account's traffic when it may be one person's, and an operator who mistakes it for the whole will
 * start reasoning about the eleven who never consented. So `contacts_total` and `contacts_linked` are
 * reported side by side and one-of-twelve is visible as one-of-twelve.
 */
crmRoutes.get('/companies/:id/analytics', requireTeamRole('analyst'), crmRateLimit, async (c) => {
	const siteId = c.get('siteId');
	const company = await loadCompany(c.env, siteId, c.req.param('id'));
	const linkage = await companyContactLinkage(
		requireCrmDb(c.env),
		siteId,
		company.id,
		COMPANY_ROLLUP_MAX_CONTACTS,
	);
	const byUid = await findLinkedVisitorHashesForMany(c.env, new URL(c.req.url), {
		siteId,
		externalUserIds: linkage.external_user_ids,
		now: Date.now(),
	});
	const hashes = [...new Set([...byUid.values()].flat())];
	const counts = {
		contacts_total: linkage.contacts_total,
		contacts_linked: byUid.size,
		contacts_considered: linkage.external_user_ids.length,
		// Never a silent cap. A truncated rollup is a lower bound, not a total, and a reader cannot
		// tell the difference from the numbers alone.
		contacts_truncated: linkage.truncated,
		contacts_limit: COMPANY_ROLLUP_MAX_CONTACTS,
	};
	if (hashes.length === 0) {
		// Same honesty as the contact route: zeroes would read as "this account did nothing", which is
		// a different claim from "nobody here has authorized a link".
		//
		// And when the fan-out was capped, even THAT is more than can be claimed. The contacts
		// resolved are the newest `contacts_limit`; older ones outside the window may well be linked,
		// so the honest reason names what was actually examined rather than asserting a fact about
		// contacts nobody looked at.
		return c.json({
			...counts,
			linked: false,
			reason: linkage.truncated ? 'none_linked_within_cap' : 'no_linked_contacts',
		});
	}
	return c.json({
		...counts,
		linked: true,
		// Deliberately NOT called `windows` like the contact response. There it is one person's live
		// salt windows; here it is contacts multiplied by theirs, so reusing the name would invite
		// reading a linkage-breadth number as a headcount. `contacts_linked` is the headcount.
		visitor_hashes: hashes.length,
		activity: await contactActivity(c.env, siteId, hashes),
	});
});
