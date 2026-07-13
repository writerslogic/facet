// Generated ambient types for Worker bindings.
// Hand-written equivalent of `wrangler types` output.

/**
 * Minimal RateLimit interface for the Cloudflare native rate-limit binding.
 * If @cloudflare/workers-types ships a fuller version, this is compatible.
 */
interface RateLimit {
	limit(opts: { key: string }): Promise<{ success: boolean }>;
}
