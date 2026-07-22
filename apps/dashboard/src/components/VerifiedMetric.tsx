// Wraps a metric surface and, when this deployment runs a signed transparency log, overlays a "Verified"
// badge. Clicking it opens the ProofDrawer, which shows the signed checkpoint (tree head) — a real
// cryptographic artifact that stands on its own — plus, when `proofRef` names a specific rollup bucket,
// that bucket's MMR inclusion proof. The badge truthfully means "this data is committed to a signed log",
// not "this exact aggregate has one proof". Degrades to bare children when the log is off.

import { ShieldCheck } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { type ProofRef, useCheckpoint } from '../hooks/transparency.js';
import { useDashboard } from '../state.js';
import { ProofDrawer } from './ProofDrawer.js';

export function VerifiedMetric({
	proofRef,
	label,
	children,
}: {
	/** The rollup bucket this metric is derived from. Omit for aggregate metrics (no badge shown). */
	proofRef?: ProofRef;
	/** Human label for the metric, shown in the proof drawer. */
	label?: string;
	children: ReactNode;
}): ReactElement {
	const { apiKey } = useDashboard();
	const { data: checkpoint } = useCheckpoint(apiKey);
	const [open, setOpen] = useState(false);
	const verifiable = Boolean(checkpoint);

	return (
		<div className="relative">
			{children}
			{verifiable ? (
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="absolute -top-3 right-3 z-10 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
					title="Committed to the cryptographic transparency log — click to view proof"
				>
					<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
					Verified
				</button>
			) : null}
			{open ? (
				<ProofDrawer
					label={label}
					proofRef={proofRef}
					checkpoint={checkpoint ?? null}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	);
}
