CREATE INDEX `idx_consent_granted_at` ON `consent_records` (`granted_at`);--> statement-breakpoint
CREATE INDEX `idx_event_rollups_interval_bucket` ON `event_rollups` (`interval`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `idx_event_sessions_started` ON `event_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_first_seen` ON `sessions` (`first_seen`);