CREATE TABLE `metric_alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`metric` text NOT NULL,
	`operator` text NOT NULL,
	`threshold` integer NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_metric_alert_rules_site` ON `metric_alert_rules` (`site_id`,`enabled`);