-- Copyright (c) 2026 Cloudflare, Inc.
-- Licensed under the Apache 2.0 license found in the LICENSE file or at:
--     https://opensource.org/licenses/Apache-2.0
--
-- Initial D1 schema for better-auth (Plan D: email+password auth).
-- Generated to match workers/auth/d1Schema.ts. Apply with:
--   wrangler d1 migrations apply DB --local
--   wrangler d1 migrations apply DB --remote

CREATE TABLE `user` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`name` TEXT NOT NULL,
	`email` TEXT NOT NULL UNIQUE,
	`email_verified` INTEGER NOT NULL DEFAULT 0,
	`image` TEXT,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	-- Plan D custom columns:
	`role` TEXT NOT NULL DEFAULT 'user',
	`active` INTEGER NOT NULL DEFAULT 1,
	-- Plan E (MFA) hooks — bake in now to avoid ALTER TABLE on populated tables:
	`two_factor_enabled` INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE `session` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`expires_at` INTEGER NOT NULL,
	`token` TEXT NOT NULL UNIQUE,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	`ip_address` TEXT,
	`user_agent` TEXT,
	`user_id` TEXT NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);

CREATE TABLE `account` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`account_id` TEXT NOT NULL,
	`provider_id` TEXT NOT NULL,
	`user_id` TEXT NOT NULL,
	`access_token` TEXT,
	`refresh_token` TEXT,
	`id_token` TEXT,
	`access_token_expires_at` INTEGER,
	`refresh_token_expires_at` INTEGER,
	`scope` TEXT,
	`password` TEXT,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);

CREATE TABLE `verification` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`identifier` TEXT NOT NULL,
	`value` TEXT NOT NULL,
	`expires_at` INTEGER NOT NULL,
	`created_at` INTEGER,
	`updated_at` INTEGER
);

CREATE TABLE `two_factor` (
	`id` TEXT PRIMARY KEY NOT NULL,
	`secret` TEXT NOT NULL,
	`backup_codes` TEXT NOT NULL,
	`user_id` TEXT NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);

-- Indexes for the common lookup paths.
CREATE INDEX `session_user_id_idx` ON `session`(`user_id`);
CREATE INDEX `account_user_id_idx` ON `account`(`user_id`);
CREATE INDEX `two_factor_user_id_idx` ON `two_factor`(`user_id`);
CREATE INDEX `verification_identifier_idx` ON `verification`(`identifier`);
