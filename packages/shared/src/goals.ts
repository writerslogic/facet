// Shared conversion & funnel types: stored goal/funnel rows and their report response shapes.

/** A single funnel step: match an event name or a path value. */
export interface FunnelStep {
	type: 'event' | 'path';
	match_value: string;
}

/** A stored conversion goal for a site. */
export interface Goal {
	id: string;
	site_id: string;
	name: string;
	type: 'event' | 'path';
	match_value: string;
	created_at: number;
}

/** A stored funnel for a site; `steps` is 2–10 ordered steps. */
export interface Funnel {
	id: string;
	site_id: string;
	name: string;
	steps: FunnelStep[];
	created_at: number;
}

/** Goal conversion report over a range. */
export interface GoalConversionResult {
	goal_id: string;
	conversions: number;
	sessions: number;
	rate: number;
}

/** One step's completion count in a funnel report. */
export interface FunnelStepCount {
	index: number;
	match_value: string;
	count: number;
}

/** Funnel report over a range: per-step counts and the overall completion rate. */
export interface FunnelReportResult {
	steps: FunnelStepCount[];
	overall_rate: number;
}
