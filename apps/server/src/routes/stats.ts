// GET /api/stats — API-key authenticated read endpoint. Validates the range, enforces that the key
// owns the requested site, and assembles the full stats response from the T021 helpers.

import { StatsQuerySchema, type StatsResponse } from "@countless/shared";
import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import {
  series,
  summary,
  topCountries,
  topDevices,
  topEvents,
  topPaths,
  topReferrers,
} from "../db/stats.js";
import type { AppEnv } from "../env.js";
import { requireApiKey } from "../lib/auth.js";
import { DAY_MS, HOUR_MS, MAX_RANGE_DAYS } from "../lib/constants.js";
import { ApiError } from "../lib/http.js";

export const statsRoutes = new Hono<AppEnv>();

statsRoutes.get(
  "/stats",
  requireApiKey,
  vValidator("query", StatsQuerySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_failed", issues: result.issues }, 400);
    }
  }),
  async (c) => {
    const query = c.req.valid("query");
    if (query.site_id !== c.get("siteId")) {
      throw new ApiError("site_mismatch", 403);
    }
    if (query.end <= query.start) {
      throw new ApiError("bad_range", 400);
    }
    if (query.end - query.start > MAX_RANGE_DAYS * DAY_MS) {
      throw new ApiError("range_too_large", 400);
    }
    const interval =
      query.interval ??
      (query.end - query.start <= 48 * HOUR_MS ? "hour" : "day");
    const f = {
      siteId: query.site_id,
      hostname: query.hostname,
      start: query.start,
      end: query.end,
    };
    const [
      summaryResult,
      seriesResult,
      paths,
      referrers,
      events,
      countries,
      devices,
    ] = await Promise.all([
      summary(c.env, f),
      series(c.env, f, interval),
      topPaths(c.env, f),
      topReferrers(c.env, f),
      topEvents(c.env, f),
      topCountries(c.env, f),
      topDevices(c.env, f),
    ]);
    const body: StatsResponse = {
      summary: summaryResult,
      series: seriesResult,
      top_paths: paths,
      top_referrers: referrers,
      top_events: events,
      top_countries: countries,
      top_devices: devices,
    };
    return c.json(body);
  },
);
