// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { LockKeyIcon } from "@phosphor-icons/react";
import { Link } from "react-router";

/**
 * Full-page message shown when an API request returns 403 because the
 * current user has no grant on the mailbox they're trying to view.
 *
 * Plan C: a non-admin user without grants sees an empty mailbox list on
 * the home page (filtered server-side). They can still reach this screen
 * via a stale URL or a recent grant revocation.
 */
export function MailboxAccessDenied({ mailboxId }: { mailboxId: string }) {
	return (
		<div className="flex flex-col items-center justify-center text-center px-6 py-20 gap-4 max-w-md mx-auto">
			<LockKeyIcon size={48} weight="thin" className="text-kumo-subtle" />
			<div>
				<h1 className="text-lg font-semibold text-kumo-default mb-1">
					No access to this mailbox
				</h1>
				<p className="text-sm text-kumo-subtle">
					<span className="font-mono">{mailboxId}</span> isn't shared with you.
					Ask an admin to grant access from the Mailbox access tab on the
					Admin page.
				</p>
			</div>
			<Link
				to="/"
				className="inline-flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
			>
				Back to my mailboxes
			</Link>
		</div>
	);
}