CREATE TABLE `scitt_mmr_leaves` (
	`leaf_no` integer PRIMARY KEY NOT NULL,
	`node_index` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scitt_mmr_nodes` (
	`node_index` integer PRIMARY KEY NOT NULL,
	`hash` text NOT NULL
);
