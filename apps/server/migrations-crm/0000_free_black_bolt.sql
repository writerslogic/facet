CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`external_user_id` text,
	`email` text,
	`name` text,
	`phone` text,
	`company` text,
	`title` text,
	`status` text DEFAULT 'lead' NOT NULL,
	`source` text,
	`notes` text,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_site_created` ON `contacts` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_contacts_site_status` ON `contacts` (`site_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_contacts_site_email` ON `contacts` (`site_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_contacts_site_extuser` ON `contacts` (`site_id`,`external_user_id`);