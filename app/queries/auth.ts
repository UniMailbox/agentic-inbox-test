// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

/**
 * TanStack Query hooks for the better-auth endpoints (Plan D).
 *
 * Sign-in / sign-up / sign-out all invalidate the `me` query so the header
 * (and any other useMe() consumer) re-fetches immediately. Better-auth sets
 * the session cookie as part of the response — we never read it directly.
 */

interface AuthArgs {
	email: string;
	password: string;
	name?: string;
}

function invalidateMe(qc: QueryClient) {
	qc.invalidateQueries({ queryKey: queryKeys.me });
}

export function useSignUp() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, password, name }: AuthArgs) =>
			api.signUp(email, password, name ?? email),
		onSuccess: () => invalidateMe(qc),
	});
}

export function useSignIn() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, password }: AuthArgs) => api.signIn(email, password),
		onSuccess: () => invalidateMe(qc),
	});
}

export function useSignOut() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.signOut(),
		onSuccess: () => invalidateMe(qc),
	});
}

export function useForgotPassword() {
	return useMutation({
		mutationFn: ({ email }: { email: string; redirectTo: string }) =>
			api.forgotPassword(email, "/reset-password"),
	});
}

export function useResetPassword() {
	return useMutation({
		mutationFn: ({ token, newPassword }: { token: string; newPassword: string }) =>
			api.resetPassword(token, newPassword),
	});
}