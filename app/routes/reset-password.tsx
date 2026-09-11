// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { AuthLayout } from "~/components/AuthLayout";
import { useResetPassword } from "~/queries/auth";

export function meta() {
	return [{ title: "Reset password · Agentic Inbox" }];
}

export default function ResetPasswordRoute() {
	const [searchParams] = useSearchParams();
	const token = searchParams.get("token");
	const reset = useResetPassword();
	const toastManager = useKumoToastManager();
	const [password, setPassword] = useState("");
	const [done, setDone] = useState(false);

	if (!token) {
		return <Navigate to="/forgot-password" replace />;
	}

	if (done) {
		return (
			<AuthLayout
				title="Password reset"
				subtitle="You can now sign in with your new password."
				footer={
					<Link to="/login" className="underline hover:text-kumo-default">
						Go to sign in
					</Link>
				}
			/>
		);
	}

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await reset.mutateAsync({ token, newPassword: password });
			setDone(true);
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Reset failed",
				variant: "error",
			});
		}
	};

	return (
		<AuthLayout
			title="Reset password"
			subtitle="Choose a new password (8+ characters)."
			footer={
				<Link to="/login" className="underline hover:text-kumo-default">
					Back to sign in
				</Link>
			}
		>
			<form onSubmit={onSubmit} className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-medium text-kumo-subtle">
						New password
					</span>
					<Input
						type="password"
						autoComplete="new-password"
						required
						minLength={8}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				<Button
					type="submit"
					variant="primary"
					disabled={reset.isPending || password.length < 8}
					className="mt-1"
				>
					{reset.isPending ? "Resetting…" : "Reset password"}
				</Button>
			</form>
		</AuthLayout>
	);
}