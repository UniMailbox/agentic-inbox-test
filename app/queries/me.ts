// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api, { type Me } from "~/services/api";
import { queryKeys } from "./keys";

/** Returns the authenticated user (Access JWT identity + admin role). */
export function useMe() {
	return useQuery<Me>({
		queryKey: queryKeys.me,
		queryFn: () => api.getMe(),
		staleTime: 60_000,
	});
}
