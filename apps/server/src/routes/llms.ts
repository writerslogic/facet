// `/llms.txt` — a plain-text map of this deployment for LLM agents, per the llms.txt convention.
//
// An agent pointed at a Facet deployment otherwise has to guess: it sees a JavaScript dashboard and
// no hint that a compact, purpose-built read path exists. This file is the cheapest possible answer:
// one unauthenticated fetch that says what the deployment is, how to authenticate, and which single
// endpoint to call for a whole-site summary. It costs a few hundred tokens and saves the agent from
// crawling the SPA or paging through the full JSON API.
//
// It deliberately exposes NO data and NO site identifiers — only the shape of the API. Nothing here
// is a secret, and nothing here is usable without an API key the operator issued.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { MAX_RANGE_DAYS } from '../lib/constants.js';

export const llmsRoutes = new Hono<AppEnv>();

llmsRoutes.get('/', (c) => {
	const origin = new URL(c.req.url).origin;
	const body = `# Facet

> Privacy-first, cookieless web analytics running on Cloudflare Workers. This deployment serves both
> the dashboard and its API from ${origin}.

## Reading analytics

All read endpoints take an API key issued by this deployment's operator, sent as
\`Authorization: Bearer clk_...\`. A key is bound to exactly ONE site; using it against a different
\`site_id\` returns \`site_mismatch\`. Ranges are unix milliseconds and may not exceed ${MAX_RANGE_DAYS} days.

### Start here

- \`GET ${origin}/api/stats/digest?site_id=<uuid>&start=<ms>&end=<ms>\`
  Returns **text/markdown**: headline traffic with period-over-period deltas, engagement, the top
  pages / referrers / countries / devices / channels, and any detected anomalies. This is the
  cheapest way to answer "how is this site doing" — prefer it over assembling the JSON endpoints.

### Everything else (application/json)

- \`GET /api/stats?site_id&start&end&interval=hour|day\` — full stats document, plus optional
  \`path\`, \`referrer\`, \`country\`, \`device\`, \`channel\` filters.
- \`GET /api/stats/realtime?site_id\` — active visitors in a trailing 5-minute window.
- \`GET /api/stats/sessions?site_id&start&end\` — sessions and engagement.
- \`GET /api/stats/channels?site_id&start&end\` — traffic channel breakdown.
- \`GET /api/stats/goals?site_id\` and \`GET /api/stats/conversions?site_id&goal_id&start&end\`
- \`GET /api/stats/funnels?site_id\` and \`GET /api/funnels/:id/report?site_id&start&end\`
- \`GET /api/stats/experiments?site_id\` and \`GET /api/stats/experiment?site_id&experiment_id&goal_type&goal_value&start&end\`
- \`GET /api/stats/export?site_id&start&end&kind=series|breakdown&format=csv|json\` — bulk export.

### Tools (MCP)

- \`POST ${origin}/api/mcp\` — Model Context Protocol endpoint (JSON-RPC 2.0) exposing the above as
  callable tools, authenticated with the same bearer API key. Use this when you can, so you fetch
  only the fields you need.

## Interpreting the numbers

Facet is cookieless. \`visitors\` counts distinct salted hashes within the salt window (daily by
default), NOT unique people: the same person on two days can count twice, and under a dimension
filter the figure is an upper bound. \`pageviews\` and \`events\` are exact. Session-derived figures
(engagement, channels, funnels, experiments) materialize on an hourly cron, so the most recent
activity may not appear yet. Cohort retention is bounded by the salt window, so cross-day retention
near zero is expected at the default setting rather than a bug.

## Writing events

- \`POST ${origin}/api/collect\` — the public ingest beacon; no API key.
- Browser client: \`npm install @writerslogic/facet\`, then \`init({ host, siteId })\` and \`track()\`.
- Or drop in \`<script defer src="${origin}/script.js" data-site-id="..."></script>\`.

## Docs

- ${origin}/.well-known/facet-privacy.json — machine-readable privacy manifest (W3C DPV terms)
- https://github.com/writerslogic/facet/blob/main/docs/api.md — full API reference
- https://github.com/writerslogic/facet/blob/main/docs/privacy.md — privacy model
`;
	return c.body(body, 200, {
		'content-type': 'text/plain; charset=utf-8',
		// Fully static apart from this deployment's own origin, and it carries nothing site-specific
		// or secret, so a shared cache may hold it. Caches key on the host, and the only reflected
		// value IS the host, so a cached copy can never name a different deployment.
		'cache-control': 'public, max-age=3600',
		// This document tells an agent where to send its API key. Serving it as anything a client
		// might sniff into an active type is a needless way to lose that instruction.
		'x-content-type-options': 'nosniff',
	});
});
