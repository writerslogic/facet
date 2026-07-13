// POST /api/collect — public, rate-limited beacon. Bot-filters, hashes the visitor, writes
// a raw event. Implementation lands in T010; this is the wiring stub.

import { Hono } from 'hono';
import type { Env } from '../env.js';

export const collectRoute = new Hono<{ Bindings: Env }>();

collectRoute.post('/', (c) => {
	return c.json({ ok: true }, 202);
});
