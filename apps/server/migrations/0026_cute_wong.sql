ALTER TABLE `experiments` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `experiments` ADD `completed_at` integer;