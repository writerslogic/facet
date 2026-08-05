CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`status` text DEFAULT 'lead' NOT NULL,
	`notes` text,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_companies_site_created` ON `companies` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_companies_site_status` ON `companies` (`site_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_companies_site_name` ON `companies` (`site_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_companies_site_domain` ON `companies` (`site_id`,`domain`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `company_id` text REFERENCES companies(id);--> statement-breakpoint
CREATE INDEX `idx_contacts_site_company` ON `contacts` (`site_id`,`company_id`);