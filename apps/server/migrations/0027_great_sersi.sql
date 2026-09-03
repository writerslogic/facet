ALTER TABLE `alert_deliveries` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `alert_deliveries` ADD `next_attempt_at` integer;--> statement-breakpoint
CREATE INDEX `idx_alert_deliveries_retry` ON `alert_deliveries` (`status`,`next_attempt_at`);