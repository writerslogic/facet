// Experiment (A/B test + feature flag) types. The server stores only aggregate exposure/conversion
// events, never per-user identity.

/** One variant of an experiment: a stable key and a non-negative bucketing weight. */
export interface ExperimentVariant {
	key: string;
	weight: number;
}

export type ExperimentStatus = 'draft' | 'active' | 'completed';

/** A stored experiment for a site; `variants` has 2–8 entries and the first is the control. */
export interface Experiment {
	id: string;
	site_id: string;
	name: string;
	flag_key: string;
	variants: ExperimentVariant[];
	status: ExperimentStatus;
	/** Compatibility mirror for clients that predate the durable lifecycle. */
	active: boolean;
	started_at: number | null;
	completed_at: number | null;
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
