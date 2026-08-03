// Side drawer that proves a metric's provenance — and, since this session, actually verifies it.
//
// It used to display proof material and say "verify offline with `facet verify`", which is a strange
// thing for a page to say while showing a green shield. The cryptography now runs here, in the
// reader's browser, over the material the server sent: the checkpoint's detached JWS is verified
// against its embedded key, the key is matched to the one published at /.well-known/jwks.json, the
// build attestation is verified and digest-bound, the displayed figures are re-hashed into a Merkle
// leaf, and the inclusion path is re-folded to the signed root. See lib/provenance.ts.
//
// Everything expensive (the MMR primitives, `jose`) is behind the dynamic import in
// hooks/transparency.ts, so opening this drawer is what downloads it — not loading the dashboard.

import { ShieldCheck, X } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef } from 'react';
import {
	type LeafClaim,
	type ProofRef,
	type SignedCheckpoint,
	useProvenance,
} from '../hooks/transparency.js';
import { formatStamp } from '../lib/datetime.js';
import { useDialogFocus } from '../lib/useDialogFocus.js';
import { useDashboard } from '../state.js';
import { ProvenanceChain } from './ProvenanceChain.js';
import { ProvenanceMerkle } from './ProvenanceMerkle.js';

/** Show a long hex/base64 string on one truncated line, full value on hover/select. */
function Mono({ value }: { value: string }): ReactElement {
	return (
		<code
			data-selectable
			className="block max-w-full truncate rounded surface-2 px-2 py-1 font-mono text-[11px] text-[color:var(--ink)]"
			title={value}
		>
			{value}
		</code>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<div>
			<div
				data-chrome
				className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[color:var(--faint)]"
			>
				{label}
			</div>
			{children}
		</div>
	);
}

export function ProofDrawer({
	label,
	proofRef,
	claim,
	checkpoint,
	onVerdict,
	onClose,
}: {
	label?: string;
	/** When set, the rollup bucket to fetch and verify an inclusion proof for. */
	proofRef?: ProofRef;
	/** The figures on the card, so the number itself can be bound to the logged record. */
	claim?: LeafClaim;
	checkpoint: SignedCheckpoint | null;
	/** Reports the verdict back to the badge, so it stops guessing and starts stating. */
	onVerdict?: (verdict: string) => void;
	onClose: () => void;
}): ReactElement {
	const { apiKey, siteId } = useDashboard();
	const { data: result, isLoading } = useProvenance(
		apiKey,
		siteId,
		proofRef ?? null,
		claim ?? null,
		true,
	);
	const panelRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	// Focus in on open, Tab trapped inside, Escape closes, focus restored to the trigger. This was
	// written here first; it is now the shared hook the site-profile dialog uses too.
	useDialogFocus(panelRef, onClose, closeRef);

	useEffect(() => {
		if (result) onVerdict?.(result.verdict);
	}, [result, onVerdict]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a real <dialog> would need imperative showModal(); this overlay is controlled by React state
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Cryptographic proof"
			className="fixed inset-0 z-50 flex justify-end"
		>
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				onClick={onClose}
				className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
			/>
			<aside
				ref={panelRef}
				className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto surface border-y-0 border-r-0 shadow-xl"
			>
				<header className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:rgb(var(--border))] surface px-5 py-4">
					<div className="flex items-center gap-2">
						<ShieldCheck className="h-5 w-5 text-pos" aria-hidden="true" />
						<h2 className="text-sm font-semibold text-[color:var(--ink)]">
							Where this number came from
						</h2>
					</div>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						// The local ring was a hardcoded --border-strong at ~1.9:1; dropping it lets the
						// shell's token focus outline (>=3:1 in every palette) apply instead.
						className="rounded-md p-1 text-[color:var(--faint)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]"
						aria-label="Close proof drawer"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</header>

				<div className="space-y-5 px-5 py-5">
					{/* The standing explanation describes a log this deployment may not run. Asserting it
					    above a verdict that says the opposite would be the drawer contradicting itself,
					    so on an unsigned deployment the verdict speaks alone. */}
					<p data-chrome className="text-xs leading-relaxed text-[color:var(--muted)]">
						{label ? (
							<span className="font-medium text-[color:var(--ink)]">{label}</span>
						) : (
							'This data'
						)}{' '}
						{result?.verdict === 'unsigned'
							? 'is shown exactly as the database returned it. What a signed deployment would additionally offer is listed below.'
							: 'is written into an append-only log the moment it is finalized, and the log publishes a signed summary of itself. Anything that changes afterwards stops matching that summary. The checks below were run here, in your browser.'}
					</p>

					<ProvenanceChain result={result ?? null} loading={isLoading}>
						{result?.fold ? (
							<section className="rounded-xl border border-[color:rgb(var(--border))] p-3.5">
								<h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--faint)]">
									The proof, step by step
								</h3>
								<p
									data-chrome
									className="mb-3 mt-1 text-xs leading-relaxed text-[color:var(--muted)]"
								>
									A fingerprint is a number you can compute from data but cannot
									work backwards from. Fold this record's fingerprint together
									with a few neighbours and you land on the one the deployment
									signed — which it did before you asked.
								</p>
								<ProvenanceMerkle
									fold={result.fold}
									failed={
										result.links.some(
											(l) => l.id === 'inclusion' && l.status === 'fail',
										) || result.fold.matchedPeak === null
									}
								/>
							</section>
						) : null}
					</ProvenanceChain>

					{checkpoint ? (
						<details className="rounded-xl border border-[color:rgb(var(--border))] p-3.5">
							<summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[color:var(--faint)]">
								Raw proof material
							</summary>
							<div className="mt-3 space-y-3">
								<Field label={`Signed root (tree size ${checkpoint.payload.size})`}>
									<Mono value={checkpoint.payload.root} />
								</Field>
								<Field label="Algorithm / key id">
									<div className="text-xs text-[color:var(--ink)]">
										<span className="font-medium">{checkpoint.proof.alg}</span>
										<span className="mx-1.5 text-[color:var(--faint)]">·</span>
										<code data-selectable className="font-mono text-[11px]">
											{checkpoint.proof.kid}
										</code>
									</div>
								</Field>
								<Field label="Signing public key (JWK)">
									<Mono value={JSON.stringify(checkpoint.proof.publicJwk)} />
								</Field>
								{checkpoint.proof.jws ? (
									<Field label="Detached JWS">
										<Mono value={checkpoint.proof.jws} />
									</Field>
								) : null}
								<Field label="Signed at">
									{/* Readable in the reader's own clock (lib/datetime owns that
									    choice app-wide), with the exact signed string kept below
									    it: this section is proof material, and the ISO instant is
									    part of the bytes the signature covers. */}
									<div
										data-selectable
										className="text-xs text-[color:var(--muted)]"
									>
										<time dateTime={checkpoint.payload.timestamp}>
											{formatStamp(Date.parse(checkpoint.payload.timestamp))}
										</time>
									</div>
									<Mono value={checkpoint.payload.timestamp} />
								</Field>
								{result?.proof ? (
									<>
										<Field label="Record key">
											<Mono value={result.proof.rollup_key} />
										</Field>
										<Field
											label={`Inclusion path (${result.proof.receipt.path.length} hashes)`}
										>
											<div className="space-y-1">
												{result.proof.receipt.path.map((h, i) => (
													<Mono key={`${i}-${h}`} value={h} />
												))}
											</div>
										</Field>
										<Field
											label={`Accumulator peaks (${result.proof.receipt.peaks.length})`}
										>
											<div className="space-y-1">
												{result.proof.receipt.peaks.map((h, i) => (
													<Mono key={`${i}-${h}`} value={h} />
												))}
											</div>
										</Field>
									</>
								) : null}
								<p data-chrome className="text-[11px] text-[color:var(--muted)]">
									Re-run all of this outside the browser with{' '}
									<code className="font-mono">facet verify</code>, or fetch{' '}
									<code className="font-mono">/api/transparency/checkpoint</code>{' '}
									yourself.
								</p>
							</div>
						</details>
					) : null}
				</div>
			</aside>
		</div>
	);
}
