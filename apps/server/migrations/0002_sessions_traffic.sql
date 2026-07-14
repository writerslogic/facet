ALTER TABLE `events` ADD `utm_source` text;--> statement-breakpoint
ALTER TABLE `events` ADD `utm_medium` text;--> statement-breakpoint
ALTER TABLE `events` ADD `utm_campaign` text;--> statement-breakpoint
ALTER TABLE `events` ADD `channel` text;--> statement-breakpoint
CREATE TABLE `event_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`day_key` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`entry_path` text NOT NULL,
	`exit_path` text NOT NULL,
	`channel` text,
	`pageviews` integer DEFAULT 0 NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`is_bounce` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_site_started` ON `event_sessions` (`site_id`,`started_at`);
