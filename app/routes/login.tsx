// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { AuthLayout } from "~/components/AuthLayout";
import { useMe } from "~/queries/me";
import { useSignIn } from "~/queries/auth";

export function meta() {
	return [{ title: "Sign in · Agentic Inbox" }];
}

export default function LoginRoute() {
	const { data: me, isLoading } = useMe();
	const signIn = useSignIn();
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const redirectTo = searchParams.get("redirectTo") ?? "/";
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	if (isLoading) return null;
	if (me) return <Navigate to={redirectTo} replace />;

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await signIn.mutateAsync({ email, password });
			navigate(redirectTo, { replace: true });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Sign in failed",
				variant: "error",
			});
		}
	};

	return (
		<AuthLayout
			title="Sign in"
			subtitle="Use your email and password."
			footer={
				<>
					<Link to="/forgot-password" className="underline hover:text-kumo-default">
						Forgot password?
					</Link>
					<span className="mx-2">·</span>
					<Link to="/signup" className="underline hover:text-kumo-default">
						Create account
					</Link>
				</>
			}
		>
			<form onSubmit={onSubmit} className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium text-kumo-subtle">Email</span>
					<Input
						type="email"
						autoComplete="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium text-kumo-subtle">Password</span>
					<Input
						type="password"
						autoComplete="current-password"
						required
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				<Button
					type="submit"
					variant="primary"
					disabled={signIn.isPending || !email || !password}
					className="mt-1"
				>
					{signIn.isPending ? "Signing in…" : "Sign in"}
				</Button>
			</form>
		</AuthLayout>
	);
}