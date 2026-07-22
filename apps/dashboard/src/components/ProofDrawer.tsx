// Side drawer that proves a metric's provenance. Section A always renders the signed checkpoint (the
// tree head: root, size, timestamp, and the alg/kid/JWK/detached-JWS signature chain) — a real, complete
// cryptographic artifact that stands on its own. Section B renders the MMR inclusion proof for a specific
// rollup bucket, fetched lazily on open (async, never blocks page load), and only when a proof ref is
// given. Verification is the CLI's job (`facet verify`); this only *displays* the proof material.

import { ShieldCheck, X } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect } from 'react';
import { type ProofRef, type SignedCheckpoint, useInclusionProof } from '../hooks/transparency.js';
import { useDashboard } from '../state.js';

/** Show a long hex/base64 string on one truncated line, full value on hover/select. */
function Mono({ value }: { value: string }): ReactElement {
	return (
		<code
			className="block max-w-full truncate rounded bg-neutral-50 px-2 py-1 font-mono text-[11px] text-neutral-700 ring-1 ring-neutral-200"
			title={value}
		>
			{value}
		</code>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}): ReactElement {
	return (
		<div>
			<div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
				{label}
			</div>
			{children}
		</div>
	);
}

export function ProofDrawer({
	label,
	proofRef,
	checkpoint,
	onClose,
}: {
	label?: string;
	/** When set, also show the inclusion proof for this specific rollup bucket. */
	proofRef?: ProofRef;
	checkpoint: SignedCheckpoint | null;
	onClose: () => void;
}): ReactElement {
	const { apiKey, siteId } = useDashboard();
	const { data: proof, isLoading, error } = useInclusionProof(apiKey, siteId, proofRef ?? null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

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
				aria-label="Close proof drawer"
				onClick={onClose}
				className="absolute inset-0 h-full w-full cursor-default bg-neutral-900/30 backdrop-blur-sm"
			/>
			<aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-neutral-200 bg-white shadow-xl">
				<header className="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
					<div className="flex items-center gap-2">
						<ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden="true" />
						<h2 className="text-sm font-semibold text-neutral-900">
							Cryptographic proof
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-400"
						aria-label="Close proof drawer"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</header>

				<div className="space-y-5 px-5 py-5">
					<p className="text-xs leading-relaxed text-neutral-500">
						{label ? (
							<span className="font-medium text-neutral-700">{label}</span>
						) : (
							'This data'
						)}{' '}
						is committed to an append-only Merkle Mountain Range transparency log. Below
						is the signed tree head; every rollup is individually provable against it.
						Verify offline with{' '}
						<code className="font-mono text-[11px]">facet verify</code>.
					</p>

					{checkpoint ? (
						<div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
							<div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
								<ShieldCheck className="h-4 w-4" aria-hidden="true" />
								Signed checkpoint (tree head)
							</div>
							<div className="space-y-3">
								<Field label={`Root (tree size ${checkpoint.payload.size})`}>
									<Mono value={checkpoint.payload.root} />
								</Field>
								<Field label="Algorithm / key id">
									<div className="text-xs text-neutral-700">
										<span className="font-medium">{checkpoint.proof.alg}</span>
										<span className="mx-1.5 text-neutral-300">·</span>
										<code className="font-mono text-[11px]">
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
									<div className="text-xs text-neutral-600">
										{checkpoint.payload.timestamp}
									</div>
								</Field>
							</div>
						</div>
					) : null}

					{proofRef ? (
						<div className="rounded-lg border border-neutral-200 p-4">
							<div className="mb-3 text-xs font-semibold text-neutral-700">
								Inclusion proof for this bucket
							</div>
							{isLoading ? (
								<div
									className="h-32 w-full animate-pulse rounded-lg bg-neutral-100"
									aria-hidden="true"
								/>
							) : error ? (
								<div
									className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700"
									role="alert"
								>
									Could not load the proof:{' '}
									{error instanceof Error ? error.message : 'unknown error'}
								</div>
							) : !proof ? (
								<div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
									This bucket isn't in the log yet — recent buckets are committed
									on the next hourly checkpoint.
								</div>
							) : (
								<div className="space-y-3">
									<Field label="Rollup">
										<Mono value={proof.rollup_key} />
									</Field>
									<Field label="Leaf">
										<Mono value={proof.receipt.leaf} />
									</Field>
									<Field
										label={`Inclusion path (${proof.receipt.path.length} hashes)`}
									>
										<div className="space-y-1">
											{proof.receipt.path.map((h, i) => (
												<Mono key={`${i}-${h}`} value={h} />
											))}
										</div>
									</Field>
									<Field
										label={`Accumulator peaks (${proof.receipt.peaks.length})`}
									>
										<div className="space-y-1">
											{proof.receipt.peaks.map((h, i) => (
												<Mono key={`${i}-${h}`} value={h} />
											))}
										</div>
									</Field>
								</div>
							)}
						</div>
					) : null}
				</div>
			</aside>
		</div>
	);
}
