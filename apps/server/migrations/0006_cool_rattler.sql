CREATE TABLE `scitt_log` (
	`entry_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`statement_hash` text NOT NULL,
	`registered_at` integer NOT NULL
);
