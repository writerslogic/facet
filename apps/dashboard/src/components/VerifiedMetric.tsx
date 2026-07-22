// Wraps a KPI card (or any metric surface) and, when this deployment runs a transparency log AND the
// metric maps to a specific rollup bucket, overlays a "Verified" badge. Clicking it opens the ProofDrawer
// with the MMR inclusion proof. Degrades to bare children when the log is off or no proof ref is given —
// a range-summary KPI aggregates many rollups and so has no single proof, and correctly shows no badge.

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
	const verifiable = Boolean(checkpoint && proofRef);

	return (
		<div className="relative">
			{children}
			{verifiable ? (
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 shadow-sm transition-colors hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
					title="Backed by the cryptographic transparency log — click to view proof"
				>
					<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
					Verified
				</button>
			) : null}
			{open && proofRef ? (
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
