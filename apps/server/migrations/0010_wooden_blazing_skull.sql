CREATE INDEX `idx_events_site_created_browser` ON `events` (`site_id`,`created_at`,`browser`);--> statement-breakpoint
CREATE INDEX `idx_events_site_created_os` ON `events` (`site_id`,`created_at`,`os`);--> statement-breakpoint
CREATE INDEX `idx_events_site_created_region` ON `events` (`site_id`,`created_at`,`region`);--> statement-breakpoint
CREATE INDEX `idx_events_site_created_network` ON `events` (`site_id`,`created_at`,`network`);