CREATE TABLE `scheduled_job_runs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`last_error` text
);
