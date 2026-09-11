// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Drizzle schema for the better-auth tables on Cloudflare D1.
 *
 * The four canonical tables (`user`, `session`, `account`, `verification`)
 * are declared with better-auth's expected shape; we add three custom
 * columns to `user`:
 *
 * - `role`       — "admin" or "user", evaluated at sign-in from ADMIN_EMAILS
 * - `active`     — soft-delete flag, admin-reversible
 * - `twoFactorEnabled` — TOTP on/off. Defaults to false so the column can be
 *                        added later (Plan E) without D1's "ALTER TABLE ADD
 *                        COLUMN NOT NULL" error on populated tables.
 *
 * IDs are strings (better-auth uses random IDs by default). We don't bake
 * the user-id-as-email choice into the schema — the sign-in hook decides
 * what to store in `user.email` and `user.name`.
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),

	// Custom extensions (Plan D):
	role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
	twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
});

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	token: text("token").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
	id: text("id").primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
	refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
	scope: text("scope"),
	password: text("password"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// One-row-per-user TOTP secret (Plan E will enable the better-auth 2FA
// plugin against this table; for now it's declared so Plan E never has
// to ALTER a populated table).
export const twoFactor = sqliteTable("two_factor", {
	id: text("id").primaryKey(),
	secret: text("secret").notNull(),
	backupCodes: text("backup_codes").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const schema = { user, session, account, verification, twoFactor };
