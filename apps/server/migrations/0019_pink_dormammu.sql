CREATE TABLE `api_key_scopes` (
	`api_key_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`api_key_id`, `scope`)
);
--> statement-breakpoint
CREATE INDEX `idx_apikeyscopes_key` ON `api_key_scopes` (`api_key_id`);--> statement-breakpoint
-- Backfill from the comma-separated `scopes` column before it's dropped below. `read`/`write`/
-- `consent` share no substrings, so a plain LIKE match can't false-positive across them.
INSERT INTO `api_key_scopes` (`api_key_id`, `scope`)
SELECT `id`, 'read' FROM `api_keys` WHERE `scopes` LIKE '%read%'
UNION ALL
SELECT `id`, 'write' FROM `api_keys` WHERE `scopes` LIKE '%write%'
UNION ALL
SELECT `id`, 'consent' FROM `api_keys` WHERE `scopes` LIKE '%consent%';
--> statement-breakpoint
ALTER TABLE `api_keys` DROP COLUMN `scopes`;