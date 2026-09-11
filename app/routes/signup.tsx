// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { AuthLayout } from "~/components/AuthLayout";
import { useMe } from "~/queries/me";
import { useSignUp } from "~/queries/auth";

export function meta() {
	return [{ title: "Create account · Agentic Inbox" }];
}

export default function SignupRoute() {
	const { data: me, isLoading } = useMe();
	const signUp = useSignUp();
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	if (isLoading) return null;
	if (me) return <Navigate to="/" replace />;

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await signUp.mutateAsync({ email, password, name: name || email });
			toastManager.add({
				title: "Account created — check your email to verify.",
			});
			navigate("/", { replace: true });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Sign up failed",
				variant: "error",
			});
		}
	};

	return (
		<AuthLayout
			title="Create account"
			subtitle="Email + password. Verification link will be sent to your inbox."
			footer={
				<>
					Already have an account?{" "}
					<Link to="/login" className="underline hover:text-kumo-default">
						Sign in
					</Link>
				</>
			}
		>
			<form onSubmit={onSubmit} className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium text-kumo-subtle">Name</span>
					<Input
						type="text"
						autoComplete="name"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
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
						autoComplete="new-password"
						required
						minLength={8}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					<span className="text-xs text-kumo-subtle">8 characters minimum.</span>
				</label>
				<Button
					type="submit"
					variant="primary"
					disabled={signUp.isPending || !email || password.length < 8}
					className="mt-1"
				>
					{signUp.isPending ? "Creating account…" : "Create account"}
				</Button>
			</form>
		</AuthLayout>
	);
}