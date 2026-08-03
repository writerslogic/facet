// Wraps a metric surface and, when this deployment runs a signed transparency log, overlays a badge
// that opens the proof drawer.
//
// WHY THE BADGE NO LONGER SAYS "VERIFIED" ON SIGHT: it used to render a green "Verified" shield
// whenever a checkpoint existed — that is, whenever *some* log was running. Nothing had been checked
// at that point. A tick rendered without verification is worse than no tick: it manufactures exactly
// the trust the product is trying to earn honestly. So the resting state is "Provable" (a claim about
// what you CAN do, which is true), and the word "Verified" appears only after the drawer has run the
// cryptography and returned a pass. A failed or unconfirmed check changes the word and the tone.
// Degrades to bare children when the log is off.

import { Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { type LeafClaim, type ProofRef, useCheckpoint } from '../hooks/transparency.js';
import { useDashboard } from '../state.js';
import { ProofDrawer } from './ProofDrawer.js';

/** The badge's four states. Wording, icon and tone all change together — never tone alone. */
const BADGE: Record<string, { word: string; badge: string; icon: typeof Shield; hint: string }> = {
	unchecked: {
		word: 'Provable',
		badge: 'badge-info',
		icon: ShieldQuestion,
		hint: 'This figure is committed to a signed transparency log — open to check it in your browser',
	},
	verified: {
		word: 'Verified',
		badge: 'badge-pos',
		icon: ShieldCheck,
		hint: 'Signature and inclusion proof were recomputed in your browser and both hold',
	},
	failed: {
		word: 'Unverified',
		badge: 'badge-neg',
		icon: ShieldAlert,
		hint: 'A check failed — open to see which one',
	},
	unconfirmed: {
		word: 'Unconfirmed',
		badge: 'badge-warn',
		icon: Shield,
		hint: 'Some checks could not be run — open to see which',
	},
};

/** Map an engine verdict to a badge state. Anything short of a full pass is never "Verified". */
function stateFor(verdict: string | null): string {
	if (verdict === null) return 'unchecked';
	if (verdict === 'verified') return 'verified';
	if (verdict === 'failed') return 'failed';
	return 'unconfirmed';
}

export function VerifiedMetric({
	proofRef,
	claim,
	label,
	children,
}: {
	/** The rollup bucket this metric is derived from. Omit for aggregate metrics. */
	proofRef?: ProofRef;
	/** The figures on the card, so the drawer can bind the number itself to the logged record. */
	claim?: LeafClaim;
	/** Human label for the metric, shown in the proof drawer. */
	label?: string;
	children: ReactNode;
}): ReactElement {
	const { apiKey } = useDashboard();
	const { data: checkpoint } = useCheckpoint(apiKey);
	const [open, setOpen] = useState(false);
	// Held here rather than in a store: the drawer is this component's child, and the verdict should
	// outlive the drawer closing so the badge keeps stating what was actually established.
	const [verdict, setVerdict] = useState<string | null>(null);
	const verifiable = Boolean(checkpoint);
	const state = BADGE[stateFor(verdict)] as (typeof BADGE)[string];
	const Icon = state.icon;

	return (
		<div className="relative">
			{children}
			{verifiable ? (
				<button
					type="button"
					onClick={() => setOpen(true)}
					// Several of these sit on one screen. The state word alone hands a screen-reader
					// user a list of identical buttons with nothing to say which metric each proves.
					aria-label={
						label
							? `${state.word}: view the proof chain for ${label}`
							: `${state.word}: view the proof chain`
					}
					className={`absolute -top-3 right-3 z-10 inline-flex items-center gap-1 rounded-full ${state.badge} px-2 py-0.5 text-[11px] font-medium shadow-sm transition-colors`}
					title={state.hint}
				>
					<Icon className="h-3.5 w-3.5" aria-hidden="true" />
					{state.word}
				</button>
			) : null}
			{open ? (
				<ProofDrawer
					label={label}
					proofRef={proofRef}
					claim={claim}
					checkpoint={checkpoint ?? null}
					onVerdict={setVerdict}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	);
}
