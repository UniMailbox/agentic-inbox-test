// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Admin: per-mailbox grants editor. Pick a mailbox, then toggle which
 * permissions each known user has on it. Plan C: "manage" implies the
 * other permissions on the backend, so the UI lets users grant any
 * combination; the server normalises on save.
 */
import { Button, Checkbox, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import {
	useAdminMailboxGrants,
	usePutAdminMailboxGrants,
} from "~/queries/grants";
import { useAdminUsers } from "~/queries/users";
import type { Permission, UserRecord } from "~/services/api";

const ALL_PERMISSIONS: Permission[] = ["read", "write", "delete", "manage"];

function formatTimestamp(iso: string) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

/** Editable view of a single user row: 4 checkboxes + a Save button per row. */
function UserGrantRow({
	user,
	initial,
	onSave,
}: {
	user: UserRecord;
	initial: Permission[];
	onSave: (next: Permission[]) => Promise<void>;
}) {
	const [perms, setPerms] = useState<Permission[]>(initial);
	const dirty = !sameSet(perms, initial);
	const toggle = (p: Permission) => {
		setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
	};

	return (
		<tr className="border-t border-kumo-line align-middle">
			<td className="px-4 py-3">
				<div className="font-medium text-kumo-default">{user.name || user.email}</div>
				<div className="text-xs text-kumo-subtle truncate max-w-xs">{user.email}</div>
			</td>
			{ALL_PERMISSIONS.map((p) => (
				<td key={p} className="px-4 py-3 text-center">
					<Checkbox
						aria-label={`${user.email}: ${p}`}
						checked={perms.includes(p)}
						onCheckedChange={() => toggle(p)}
					/>
				</td>
			))}
			<td className="px-4 py-3 text-right">
				<Button
					variant="primary"
					size="xs"
					disabled={!dirty}
					onClick={() => onSave(perms)}
				>
					Save
				</Button>
			</td>
		</tr>
	);
}

function sameSet(a: Permission[], b: Permission[]) {
	if (a.length !== b.length) return false;
	const sb = new Set(b);
	return a.every((x) => sb.has(x));
}

export function MailboxAccessEditor({
	mailboxes,
}: {
	mailboxes: { id: string; name?: string }[];
}) {
	const toastManager = useKumoToastManager();
	const [selectedMailbox, setSelectedMailbox] = useState<string>("");

	// Default-select the first mailbox once the list loads.
	useEffect(() => {
		if (!selectedMailbox && mailboxes.length > 0) {
			setSelectedMailbox(mailboxes[0].id);
		}
	}, [mailboxes, selectedMailbox]);

	const { data: users = [], isLoading: usersLoading } = useAdminUsers();
	const { data: grants, isLoading: grantsLoading } = useAdminMailboxGrants(selectedMailbox);
	const putGrants = usePutAdminMailboxGrants();

	const existing = grants?.grants ?? {};
	// Sort users: those with grants first (sorted by email), then those without.
	const sortedUsers = useMemo(() => {
		const withGrants = users.filter((u) => existing[u.id]);
		const withoutGrants = users.filter((u) => !existing[u.id]);
		const byEmail = (a: UserRecord, b: UserRecord) => a.email.localeCompare(b.email);
		return [...withGrants.sort(byEmail), ...withoutGrants.sort(byEmail)];
	}, [users, existing]);

	if (mailboxes.length === 0) {
		return (
			<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6 text-center">
				<p className="text-sm text-kumo-subtle">
					No mailboxes yet. Create one from the sidebar before assigning access.
				</p>
			</div>
		);
	}

	const handleSave = async (userId: string, perms: Permission[]) => {
		if (!selectedMailbox) return;
		const next: Record<string, { permissions: Permission[] }> = { ...existing };
		if (perms.length === 0) {
			delete next[userId];
		} else {
			next[userId] = { permissions: perms };
		}
		try {
			await putGrants.mutateAsync({ mailboxId: selectedMailbox, grants: next });
			toastManager.add({ title: "Access updated" });
		} catch (err) {
			toastManager.add({
				title: (err instanceof Error ? err.message : null) || "Failed to save access",
				variant: "error",
			});
		}
	};

	const selectedMailboxLabel = mailboxes.find((m) => m.id === selectedMailbox)?.name;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<label
					htmlFor="mailbox-access-select"
					className="text-sm font-medium text-kumo-default"
				>
					Mailbox
				</label>
				<div className="min-w-64 flex-1 max-w-md">
					<Select
						id="mailbox-access-select"
						value={selectedMailbox}
						onValueChange={(v) => v && setSelectedMailbox(v)}
					>
						{mailboxes.map((m) => (
							<Select.Option key={m.id} value={m.id}>
								{m.name ?? m.id}
							</Select.Option>
						))}
					</Select>
				</div>
			</div>

			{usersLoading || grantsLoading ? (
				<div className="flex justify-center py-16">
					<Loader size="lg" />
				</div>
			) : (
				<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
					<table className="w-full text-sm">
						<thead className="bg-kumo-recessed text-kumo-subtle">
							<tr>
								<th className="text-left font-medium px-4 py-2.5">User</th>
								{ALL_PERMISSIONS.map((p) => (
									<th key={p} className="text-center font-medium px-2 py-2.5">
										{p}
									</th>
								))}
								<th className="text-right font-medium px-4 py-2.5">Actions</th>
							</tr>
						</thead>
						<tbody>
							{sortedUsers.length === 0 ? (
								<tr>
									<td
										colSpan={ALL_PERMISSIONS.length + 2}
										className="px-4 py-12 text-center text-kumo-subtle"
									>
										No users yet.
									</td>
								</tr>
							) : (
								sortedUsers.map((u) => (
									<UserGrantRow
										key={u.id}
										user={u}
										initial={existing[u.id]?.permissions ?? []}
										onSave={(next) => handleSave(u.id, next)}
									/>
								))
							)}
						</tbody>
					</table>
				</div>
			)}

			{selectedMailboxLabel && (
				<p className="text-xs text-kumo-subtle">
					Editing access for <span className="font-medium">{selectedMailboxLabel}</span>.
					Permissions marked <span className="font-medium">manage</span> imply all others
					on the server.
				</p>
			)}
			{existing[Object.keys(existing)[0] ?? ""]?.grantedAt && (
				<p className="text-xs text-kumo-subtle">
					Last change: {formatTimestamp(existing[Object.keys(existing)[0] ?? ""].grantedAt)}
				</p>
			)}
		</div>
	);
}