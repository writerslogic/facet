CREATE TABLE `flags` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`flag_key` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`default_variant` text NOT NULL,
	`variants` text NOT NULL,
	`rules` text DEFAULT '[]' NOT NULL,
	`salt` text NOT NULL,
	`rollout_seed` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flags_site` ON `flags` (`site_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flags_site_key` ON `flags` (`site_id`,`flag_key`);