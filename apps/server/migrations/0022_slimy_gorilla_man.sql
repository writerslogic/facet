CREATE TABLE `bot_rulesets` (
	`source` text PRIMARY KEY NOT NULL,
	`patterns` text NOT NULL,
	`etag` text,
	`pattern_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `scheduled_job_runs` ADD `last_occurrence` integer;--> statement-breakpoint
ALTER TABLE `scheduled_job_runs` ADD `cadence_error` text;