CREATE TABLE `mmr_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tree_size` integer NOT NULL,
	`root` text NOT NULL,
	`created_at` integer NOT NULL,
	`signed` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mmr_leaves` (
	`leaf_no` integer PRIMARY KEY NOT NULL,
	`node_index` integer NOT NULL,
	`rollup_key` text NOT NULL,
	`leaf_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mmr_leaves_rollup_key_unique` ON `mmr_leaves` (`rollup_key`);--> statement-breakpoint
CREATE TABLE `mmr_nodes` (
	`node_index` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL
);
