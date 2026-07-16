// Shared experiment (A/B test + feature flag) types: the stored experiment row, its variant shape,
// and the per-variant significance result. Variant assignment is client-side; the server only ever
// stores aggregate exposure/conversion events (no server-side per-user identity).

/** One variant of an experiment: a stable key and a non-negative bucketing weight. */
export interface ExperimentVariant {
	key: string;
	weight: number;
}

/** A stored experiment for a site; `variants` has 2–8 entries and the first is the control. */
export interface Experiment {
	id: string;
	site_id: string;
	name: string;
	flag_key: string;
	variants: ExperimentVariant[];
	active: boolean;
	created_at: number;
}

/** Per-variant experiment result: exposures, conversions, rate, and significance vs. control. */
export interface ExperimentResult {
	variants: {
		key: string;
		exposures: number;
		conversions: number;
		rate: number;
		p_value: number | null;
		significant: boolean;
	}[];
}
