// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { useState } from "react";
import { Link } from "react-router";
import { AuthLayout } from "~/components/AuthLayout";
import { useForgotPassword } from "~/queries/auth";

export function meta() {
	return [{ title: "Forgot password · Agentic Inbox" }];
}

export default function ForgotPasswordRoute() {
	const forgot = useForgotPassword();
	const toastManager = useKumoToastManager();
	const [email, setEmail] = useState("");
	const [submitted, setSubmitted] = useState(false);

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await forgot.mutateAsync({
				email,
				redirectTo: `${window.location.origin}/reset-password`,
			});
			setSubmitted(true);
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Request failed",
				variant: "error",
			});
		}
	};

	if (submitted) {
		return (
			<AuthLayout
				title="Check your email"
				subtitle={
					"If that address is registered, we sent a password reset link."
				}
				footer={
					<Link to="/login" className="underline hover:text-kumo-default">
						Back to sign in
					</Link>
				}
			>
				<p className="text-sm text-kumo-subtle">
					The link expires in 1 hour.
				</p>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout
			title="Forgot password"
			subtitle="Enter your email and we'll send a reset link."
			footer={
				<Link to="/login" className="underline hover:text-kumo-default">
					Back to sign in
				</Link>
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
				<Button
					type="submit"
					variant="primary"
					disabled={forgot.isPending || !email}
					className="mt-1"
				>
					{forgot.isPending ? "Sending…" : "Send reset link"}
				</Button>
			</form>
		</AuthLayout>
	);
}