CREATE TABLE `consent_records` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`tier` text NOT NULL,
	`external_user_id` text,
	`salt_window` text NOT NULL,
	`window_key` text NOT NULL,
	`gpc_at_grant` integer DEFAULT 0 NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`statement` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_consent_site_visitor` ON `consent_records` (`site_id`,`visitor_hash`,`tier`);--> statement-breakpoint
CREATE INDEX `idx_consent_site_extuser` ON `consent_records` (`site_id`,`external_user_id`);--> statement-breakpoint
CREATE TABLE `identity_salts` (
	`scope` text PRIMARY KEY NOT NULL,
	`salt` text NOT NULL,
	`window` text NOT NULL,
	`window_end` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_identity_salts_window_end` ON `identity_salts` (`window_end`);--> statement-breakpoint
CREATE TABLE `site_config` (
	`site_id` text PRIMARY KEY NOT NULL,
	`tier` text DEFAULT 'anonymous' NOT NULL,
	`salt_window` text DEFAULT 'day' NOT NULL,
	`updated_at` integer NOT NULL
);
