// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tabs, useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Navigate } from "react-router";
import { useMe } from "~/queries/me";
import {
	useAdminUsers,
	useDeactivateUser,
	useUpdateUserRole,
} from "~/queries/users";
import { useMailboxes } from "~/queries/mailboxes";
import { MailboxAccessEditor } from "~/components/admin/MailboxAccessEditor";

export function meta() {
	return [{ title: "Admin · Agentic Inbox" }];
}

function formatTimestamp(iso: string) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function UsersTab() {
	const { data: me } = useMe();
	const { data: users = [], isLoading: usersLoading } = useAdminUsers();
	const updateRole = useUpdateUserRole();
	const deactivate = useDeactivateUser();
	const toastManager = useKumoToastManager();
	const [busySub, setBusySub] = useState<string | null>(null);

	const handleToggleRole = async (sub: string, currentRole: "admin" | "user") => {
		setBusySub(sub);
		try {
			const next = currentRole === "admin" ? "user" : "admin";
			await updateRole.mutateAsync({ sub, role: next });
			toastManager.add({
				title: next === "admin" ? "Promoted to admin" : "Demoted to user",
			});
		} catch (err) {
			toastManager.add({
				title: (err instanceof Error ? err.message : null) || "Failed to update role",
				variant: "error",
			});
		} finally {
			setBusySub(null);
		}
	};

	const handleDeactivate = async (sub: string, email: string) => {
		if (!confirm(`Deactivate ${email}? They will be signed out immediately.`)) return;
		setBusySub(sub);
		try {
			await deactivate.mutateAsync(sub);
			toastManager.add({ title: "User deactivated" });
		} catch (err) {
			toastManager.add({
				title: (err instanceof Error ? err.message : null) || "Failed to deactivate",
				variant: "error",
			});
		} finally {
			setBusySub(null);
		}
	};

	if (usersLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	if (users.length === 0) {
		return (
			<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6 text-center">
				<p className="text-sm text-kumo-subtle">No users yet.</p>
			</div>
		);
	}

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			<table className="w-full text-sm">
				<thead className="bg-kumo-recessed text-kumo-subtle">
					<tr>
						<th className="text-left font-medium px-4 py-2.5">User</th>
						<th className="text-left font-medium px-4 py-2.5">Role</th>
						<th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">
							Last seen
						</th>
						<th className="text-right font-medium px-4 py-2.5">Actions</th>
					</tr>
				</thead>
				<tbody>
					{users.map((u) => {
						const isSelf = me && u.id === me.id;
						const isBusy = busySub === u.id;
						return (
							<tr key={u.id} className="border-t border-kumo-line align-middle">
								<td className="px-4 py-3">
									<div className="font-medium text-kumo-default">
										{u.name || u.email}
										{isSelf && (
											<span className="ml-2 text-xs text-kumo-subtle">(you)</span>
										)}
									</div>
									<div className="text-xs text-kumo-subtle truncate max-w-xs">
										{u.email}
									</div>
								</td>
								<td className="px-4 py-3">
									<div className="flex items-center gap-2">
										<Badge
											variant={u.role === "admin" ? "primary" : "secondary"}
										>
											{u.role}
										</Badge>
										{!u.active && <Badge variant="secondary">inactive</Badge>}
									</div>
								</td>
								<td className="px-4 py-3 text-kumo-subtle hidden md:table-cell">
									{formatTimestamp(u.lastSeenAt)}
								</td>
								<td className="px-4 py-3 text-right">
									<div className="flex justify-end gap-2">
										<Button
											variant="ghost"
											size="xs"
											disabled={isBusy || (isSelf && u.role === "admin")}
											onClick={() => handleToggleRole(u.id, u.role)}
											title={
												isSelf && u.role === "admin"
													? "You cannot demote yourself"
													: undefined
											}
										>
											{u.role === "admin" ? "Demote" : "Promote"}
										</Button>
										<Button
											variant="ghost"
											size="xs"
											disabled={isBusy || !!isSelf || !u.active}
											onClick={() => handleDeactivate(u.id, u.email)}
										>
											Deactivate
										</Button>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function MailboxAccessTab() {
	const { data: mailboxes = [], isLoading } = useMailboxes();
	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}
	return (
		<MailboxAccessEditor
			mailboxes={mailboxes.map((m) => ({ id: m.id, name: m.name ?? m.email ?? m.id }))}
		/>
	);
}

export default function AdminRoute() {
	const { data: me, isLoading: meLoading } = useMe();
	const [tab, setTab] = useState("users");

	if (meLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	if (!me?.isAdmin) {
		return <Navigate to="/" replace />;
	}

	return (
		<div className="mx-auto max-w-4xl px-4 py-8 md:px-6 md:py-12">
			<div className="mb-6">
				<h1 className="text-2xl font-bold text-kumo-default">Admin</h1>
				<p className="text-sm text-kumo-subtle mt-1">
					Manage users and per-mailbox access for everyone in your organization.
				</p>
			</div>

			<Tabs
				variant="segmented"
				className="mb-6"
				value={tab}
				onValueChange={setTab}
				tabs={[
					{ value: "users", label: "Users" },
					{ value: "mailboxes", label: "Mailbox access" },
				]}
			/>

			{tab === "users" && <UsersTab />}
			{tab === "mailboxes" && <MailboxAccessTab />}
		</div>
	);
}