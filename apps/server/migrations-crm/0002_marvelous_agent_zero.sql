CREATE TABLE `crm_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_crm_audit_site_time` ON `crm_audit_log` (`site_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_audit_site_target` ON `crm_audit_log` (`site_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_crm_audit_occurred` ON `crm_audit_log` (`occurred_at`);