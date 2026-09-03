CREATE TABLE `crm_contact_events` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`site_id`,`contact_id`) REFERENCES `crm_contacts`(`site_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_crm_contact_events_type" CHECK(length("crm_contact_events"."event_type") BETWEEN 1 AND 64 AND "crm_contact_events"."event_type" = lower("crm_contact_events"."event_type") AND "crm_contact_events"."event_type" NOT GLOB '*[^a-z0-9_.-]*'),
	CONSTRAINT "ck_crm_contact_events_payload" CHECK("crm_contact_events"."payload" IS NULL OR (json_valid("crm_contact_events"."payload") AND length("crm_contact_events"."payload") <= 4096)),
	CONSTRAINT "ck_crm_contact_events_occurred_at" CHECK("crm_contact_events"."occurred_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_crm_events_contact_occurred_id` ON `crm_contact_events` (`site_id`,`contact_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `crm_contact_tags` (
	`site_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `contact_id`, `tag_id`),
	FOREIGN KEY (`site_id`,`contact_id`) REFERENCES `crm_contacts`(`site_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`,`tag_id`) REFERENCES `crm_tags`(`site_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_crm_contact_tags_created_at" CHECK("crm_contact_tags"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_crm_contact_tags_site_tag_contact` ON `crm_contact_tags` (`site_id`,`tag_id`,`contact_id`);--> statement-breakpoint
CREATE TABLE `crm_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`external_id_hash` text NOT NULL,
	`alias` text,
	`lifecycle_state` text DEFAULT 'lead' NOT NULL,
	`legal_basis` text NOT NULL,
	`origin_source` text NOT NULL,
	`origin_occurred_at` integer NOT NULL,
	`consent_captured_at` integer,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ck_crm_contacts_external_id_hash" CHECK(length("crm_contacts"."external_id_hash") = 64 AND "crm_contacts"."external_id_hash" = lower("crm_contacts"."external_id_hash") AND "crm_contacts"."external_id_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ck_crm_contacts_alias" CHECK("crm_contacts"."alias" IS NULL OR length("crm_contacts"."alias") BETWEEN 1 AND 160),
	CONSTRAINT "ck_crm_contacts_lifecycle_state" CHECK("crm_contacts"."lifecycle_state" IN ('lead', 'active', 'churned')),
	CONSTRAINT "ck_crm_contacts_legal_basis" CHECK("crm_contacts"."legal_basis" IN ('consent', 'contract', 'legitimate_interest', 'legal_obligation', 'vital_interest', 'public_task')),
	CONSTRAINT "ck_crm_contacts_origin_source" CHECK(length("crm_contacts"."origin_source") BETWEEN 1 AND 64 AND "crm_contacts"."origin_source" = lower("crm_contacts"."origin_source") AND "crm_contacts"."origin_source" NOT GLOB '*[^a-z0-9_.-]*'),
	CONSTRAINT "ck_crm_contacts_timestamps" CHECK("crm_contacts"."origin_occurred_at" >= 0 AND "crm_contacts"."created_at" >= 0 AND "crm_contacts"."updated_at" >= "crm_contacts"."created_at"),
	CONSTRAINT "ck_crm_contacts_consent" CHECK(("crm_contacts"."consent_captured_at" IS NULL OR "crm_contacts"."consent_captured_at" >= 0) AND ("crm_contacts"."legal_basis" <> 'consent' OR "crm_contacts"."consent_captured_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_crm_contacts_site_id` ON `crm_contacts` (`site_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_crm_contacts_site_external_id` ON `crm_contacts` (`site_id`,`external_id_hash`);--> statement-breakpoint
CREATE INDEX `idx_crm_contacts_site_created_id` ON `crm_contacts` (`site_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_crm_contacts_site_score_id` ON `crm_contacts` (`site_id`,`score`,`id`);--> statement-breakpoint
CREATE INDEX `idx_crm_contacts_site_lifecycle_id` ON `crm_contacts` (`site_id`,`lifecycle_state`,`id`);--> statement-breakpoint
CREATE TABLE `crm_score_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`previous_score` integer NOT NULL,
	`delta` integer NOT NULL,
	`next_score` integer NOT NULL,
	`reason` text NOT NULL,
	`rule_id` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`site_id`,`contact_id`) REFERENCES `crm_contacts`(`site_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_crm_score_ledger_arithmetic" CHECK("crm_score_ledger"."next_score" = "crm_score_ledger"."previous_score" + "crm_score_ledger"."delta"),
	CONSTRAINT "ck_crm_score_ledger_delta" CHECK("crm_score_ledger"."delta" <> 0),
	CONSTRAINT "ck_crm_score_ledger_reason" CHECK(length("crm_score_ledger"."reason") BETWEEN 1 AND 64 AND "crm_score_ledger"."reason" = lower("crm_score_ledger"."reason") AND "crm_score_ledger"."reason" NOT GLOB '*[^a-z0-9_.-]*'),
	CONSTRAINT "ck_crm_score_ledger_rule_id" CHECK("crm_score_ledger"."rule_id" IS NULL OR length("crm_score_ledger"."rule_id") BETWEEN 1 AND 64),
	CONSTRAINT "ck_crm_score_ledger_occurred_at" CHECK("crm_score_ledger"."occurred_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_crm_score_contact_occurred_id` ON `crm_score_ledger` (`site_id`,`contact_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `crm_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`normalized_name` text NOT NULL,
	`display_name` text NOT NULL,
	`color_token` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "ck_crm_tags_normalized_name" CHECK(length("crm_tags"."normalized_name") BETWEEN 1 AND 64 AND "crm_tags"."normalized_name" = lower("crm_tags"."normalized_name") AND "crm_tags"."normalized_name" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "ck_crm_tags_display_name" CHECK(length("crm_tags"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "ck_crm_tags_color_token" CHECK("crm_tags"."color_token" IN ('slate', 'violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose')),
	CONSTRAINT "ck_crm_tags_created_at" CHECK("crm_tags"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_crm_tags_site_id` ON `crm_tags` (`site_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_crm_tags_site_normalized_name` ON `crm_tags` (`site_id`,`normalized_name`);