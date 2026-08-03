CREATE TABLE `alert_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`site_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alert_deliveries_dedupe` ON `alert_deliveries` (`destination_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_alert_deliveries_site` ON `alert_deliveries` (`site_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alert_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target` text NOT NULL,
	`min_severity` text DEFAULT 'warning' NOT NULL,
	`secret` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_alert_destinations_site` ON `alert_destinations` (`site_id`);