// CRM endpoints — the optional contacts extension. Two gates apply to every route here, in order.
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
//    Roles: `analyst` reads and edits contacts; `admin` is required to DELETE one or to export it.
//    Those two are the irreversible and the bulk-disclosure operations, and `viewer` — who can see
//    aggregate analytics — has no CRM access at all, because PII is a different kind of access, not
//    more of the same one.
//
// The contact→analytics link (`GET /:id/analytics`) never queries events by anything a contact row
// controls. It resolves `external_user_id` through `findLinkedVisitorHashes`, which returns hashes
// only from consent statements that verify against the deployment key — so a contact with no active
// consent is simply not connected to any analytics, and there is no code path that could make it so.

import {
	CONTACTS_DEFAULT_PAGE,
	ContactCreateSchema,
	ContactListQuerySchema,
	ContactUpdateSchema,
} from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
	CONTACT_EXPORT_MAX_EVENTS,
	contactActivity,
	contactConsentRecords,
	contactEvents,
} from '../db/contact-analytics.js';
import {
	type Contact,
	deleteContact,
	getContact,
	insertContact,
	listContacts,
	requireCrm,
	requireCrmDb,
	uniqueConstraintText,
	updateContact,
} from '../db/crm.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv, Env } from '../env.js';
import { requireTeamRole } from '../lib/auth.js';
import { eraseConsentByExternalUserId, findLinkedVisitorHashes } from '../lib/consent.js';
import { ApiError, validationErrorHook } from '../lib/http.js';

export const crmRoutes = new Hono<AppEnv>();

crmRoutes.use('*', requireCrm);

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

crmRoutes.get(
	'/contacts',
	requireTeamRole('analyst'),
	vValidator('query', ContactListQuerySchema, validationErrorHook),
	async (c) => {
		const query = c.req.valid('query');
		const { contacts, total } = await listContacts(requireCrmDb(c.env), c.get('siteId'), {
			status: query.status,
			q: query.q,
			limit: query.limit ?? CONTACTS_DEFAULT_PAGE,
			offset: query.offset ?? 0,
		});
		return c.json({ contacts, total });
	},
);

crmRoutes.post(
	'/contacts',
	requireTeamRole('analyst'),
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
		).catch((err: unknown) => {
			// The (site_id, email) / (site_id, external_user_id) unique indexes are the dedupe. A
			// collision is a client mistake, not a server fault, and saying which field collided is
			// safe: the caller already holds a role on this site and submitted the value itself.
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
			throw err;
		});
		return c.json({ contact }, 201);
	},
);

crmRoutes.get('/contacts/:id', requireTeamRole('analyst'), async (c) => {
	const contact = await loadContact(c.env, c.get('siteId'), c.req.param('id'));
	return c.json({ contact });
});

crmRoutes.patch(
	'/contacts/:id',
	requireTeamRole('analyst'),
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
		).catch((err: unknown) => {
			if (uniqueConstraintText(err)) {
				throw new ApiError(
					'contact_exists',
					409,
					'another contact already holds that value',
				);
			}
			throw err;
		});
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
crmRoutes.delete('/contacts/:id', requireTeamRole('admin'), async (c) => {
	const siteId = c.get('siteId');
	const contact = await deleteContact(requireCrmDb(c.env), siteId, c.req.param('id'));
	if (!contact) {
		throw new ApiError('not_found', 404);
	}
	const consentErased = contact.external_user_id
		? await eraseConsentByExternalUserId(c.env, {
				siteId,
				externalUserId: contact.external_user_id,
			})
		: 0;
	return c.json({ deleted: true, consent_records_erased: consentErased });
});

/** A contact's analytics, if and only if an active signed consent record authorizes the link. When
 * it does not, the response says so explicitly rather than returning zeroes that read like "this
 * person did nothing" — `linked: false` and a reason are the honest answer. */
crmRoutes.get('/contacts/:id/analytics', requireTeamRole('analyst'), async (c) => {
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
crmRoutes.get('/contacts/:id/export', requireTeamRole('admin'), async (c) => {
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
			// the complete record and answer a subject-access request incorrectly.
			events_truncated: activity.events > events.length,
			events_limit: CONTACT_EXPORT_MAX_EVENTS,
		},
	});
});
