// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type UserRecord } from "~/services/api";
import { queryKeys } from "./keys";

export function useAdminUsers() {
	return useQuery<UserRecord[]>({
		queryKey: queryKeys.adminUsers,
		queryFn: async () => {
			const res = await api.listAdminUsers();
			return res.users;
		},
	});
}

export function useUpdateUserRole() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ sub, role }: { sub: string; role: "admin" | "user" }) =>
			api.updateAdminUserRole(sub, role),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminUsers });
			// The current user's own role may have changed; refresh /me too.
			qc.invalidateQueries({ queryKey: queryKeys.me });
		},
	});
}

export function useDeactivateUser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (sub: string) => api.deactivateAdminUser(sub),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminUsers });
		},
	});
}

export function useReactivateUser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (sub: string) => api.reactivateAdminUser(sub),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminUsers });
		},
	});
}
