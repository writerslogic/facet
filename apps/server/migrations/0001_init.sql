CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`hostname` text NOT NULL,
	`path` text NOT NULL,
	`referrer` text DEFAULT '' NOT NULL,
	`name` text,
	`props` text,
	`visitor_hash` text NOT NULL,
	`country` text,
	`device` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_rollups` (
	`site_id` text NOT NULL,
	`hostname` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`interval` text NOT NULL,
	`pageviews` integer DEFAULT 0 NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	`visitors` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `hostname`, `bucket_start`, `interval`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`site_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`day_key` text NOT NULL,
	`first_seen` integer NOT NULL,
	PRIMARY KEY(`site_id`, `visitor_hash`, `day_key`)
);
--> statement-breakpoint
CREATE TABLE `salts` (
	`day_key` text PRIMARY KEY NOT NULL,
	`salt` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
--> statement-breakpoint
CREATE INDEX `idx_events_site_created_name` ON `events` (`site_id`,`created_at`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_events_site_host_created` ON `events` (`site_id`,`hostname`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_apikeys_site` ON `api_keys` (`site_id`);
