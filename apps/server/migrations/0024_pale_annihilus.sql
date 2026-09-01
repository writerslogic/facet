CREATE TABLE `timeline_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`label` text NOT NULL,
	`category` text DEFAULT 'note' NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_timeline_annotations_site_time` ON `timeline_annotations` (`site_id`,`occurred_at`);