// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type Grant, type Grants, type Permission } from "~/services/api";
import { queryKeys } from "./keys";

/** All grants across every mailbox — used by the /admin grants editor. */
export function useAdminGrants() {
	return useQuery<Grants[]>({
		queryKey: queryKeys.adminGrants.all,
		queryFn: async () => {
			const res = await api.listAdminGrants();
			return res.grants;
		},
	});
}

/** Grants for a single mailbox — used by the per-mailbox editor on /admin. */
export function useAdminMailboxGrants(mailboxId: string | undefined) {
	return useQuery<Grants>({
		queryKey: mailboxId ? queryKeys.adminGrants.detail(mailboxId) : ["admin", "grants", "none"],
		queryFn: () => api.getAdminGrants(mailboxId!),
		enabled: !!mailboxId,
	});
}

/** Replace the grant set for one mailbox. The whole record is replaced, not merged. */
export function usePutAdminMailboxGrants() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			grants,
		}: {
			mailboxId: string;
			grants: Record<string, { permissions: Permission[] }>;
		}) => api.putAdminGrants(mailboxId, grants),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.adminGrants.detail(data.mailboxId), data);
			qc.invalidateQueries({ queryKey: queryKeys.adminGrants.all });
			// The visible mailbox list depends on the caller's grants.
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

// Re-exported so the editor can refer to the shape next to its hooks.
export type { Grant, Grants, Permission };