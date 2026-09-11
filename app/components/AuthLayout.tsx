// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared layout for the auth pages (login, signup, forgot/reset password).
 *
 * Centered card with the app name and a slot for the form. Keeps the page
 * chrome identical across all four routes so users always know where they are.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

interface Props {
	title: string;
	subtitle?: string;
	children?: ReactNode;
	footer?: ReactNode;
}

export function AuthLayout({ title, subtitle, children, footer }: Props) {
	return (
		<div className="flex items-center justify-center min-h-screen px-4 py-12 bg-kumo-recessed">
			<div className="w-full max-w-sm">
				<Link
					to="/"
					className="block text-center text-lg font-semibold text-kumo-default mb-6"
				>
					Agentic Inbox
				</Link>
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6 shadow-sm">
					<h1 className="text-xl font-bold text-kumo-default">{title}</h1>
					{subtitle && (
						<p className="mt-1 text-sm text-kumo-subtle">{subtitle}</p>
					)}
					<div className="mt-5">{children}</div>
				</div>
				{footer && (
					<div className="mt-4 text-center text-sm text-kumo-subtle">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}