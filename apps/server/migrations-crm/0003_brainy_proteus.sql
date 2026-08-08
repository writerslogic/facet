CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`company_id` text,
	`contact_id` text,
	`stage` text DEFAULT 'lead' NOT NULL,
	`value` integer,
	`currency` text,
	`expected_close_date` integer,
	`notes` text,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deals_site_created` ON `deals` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_deals_site_stage` ON `deals` (`site_id`,`stage`);--> statement-breakpoint
CREATE INDEX `idx_deals_site_company` ON `deals` (`site_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `idx_deals_site_contact` ON `deals` (`site_id`,`contact_id`);