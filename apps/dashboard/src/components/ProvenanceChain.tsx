// The custody chain, read top to bottom: this number → signed by this key → that key is published
// here → produced by this attested build → recorded at this position in the log → and the log's own
// signed summary reproduces from it.
//
// THE RULE THIS COMPONENT ENFORCES: a link renders as "Verified here" only when the engine set BOTH
// `status: 'pass'` AND `checked: true` — i.e. cryptography ran in this browser and returned true.
// Anything else gets its own word ("Failed", "Not checked", "Not available", "Not applicable") and
// its own icon, so a grey link can never be mistaken for a green one at a glance. A tick that was
// rendered without verifying anything would be worse than no tick, because it manufactures trust.

import { AlertTriangle, Check, CircleDashed, Minus, X } from 'lucide-react';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import type { ProvenanceLink, ProvenanceResult } from '../lib/provenance.js';

/** How each outcome is worded, iconed and toned. Never tone alone — the word carries the meaning. */
function tone(link: ProvenanceLink): {
	word: string;
	badge: string;
	icon: ReactElement;
	dot: string;
} {
	const verified = link.status === 'pass' && link.checked;
	if (verified) {
		return {
			word: 'Verified here',
			badge: 'badge-pos',
			icon: <Check className="h-3 w-3" aria-hidden="true" />,
			dot: 'var(--pos)',
		};
	}
	if (link.status === 'fail') {
		return {
			word: 'Failed',
			badge: 'badge-neg',
			icon: <X className="h-3 w-3" aria-hidden="true" />,
			dot: 'var(--neg)',
		};
	}
	if (link.status === 'warn') {
		return {
			word: 'Not checked',
			badge: 'badge-warn',
			icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
			dot: 'var(--warn)',
		};
	}
	if (link.status === 'pass') {
		return {
			word: 'Reported',
			badge: 'badge-info',
			icon: <CircleDashed className="h-3 w-3" aria-hidden="true" />,
			dot: 'var(--info)',
		};
	}
	return {
		word: link.status === 'skip' ? 'Not available' : 'Not applicable',
		badge: 'badge-neutral',
		icon: <Minus className="h-3 w-3" aria-hidden="true" />,
		dot: 'var(--faint)',
	};
}

/** A hash, key id or log position: data the reader will want to copy, even inside chrome. */
function Value({ value, mono }: { value: string; mono?: boolean }): ReactElement {
	return (
		<span
			data-selectable
			className={
				mono
					? 'min-w-0 break-all font-mono text-[11px] text-[color:var(--ink)]'
					: 'min-w-0 break-words text-[11px] text-[color:var(--ink)]'
			}
		>
			{value}
		</span>
	);
}

function ChainLink({
	link,
	last,
	showDetail,
}: {
	link: ProvenanceLink;
	last: boolean;
	showDetail: boolean;
}): ReactElement {
	const t = tone(link);
	return (
		<li className="relative flex gap-3 pb-4 last:pb-0">
			{/* The connector is what makes this read as a chain rather than a checklist. */}
			{last ? null : (
				<span
					aria-hidden="true"
					className="absolute left-[11px] top-6 bottom-0 w-px"
					style={{ backgroundColor: 'rgb(var(--border))' }}
				/>
			)}
			<span
				aria-hidden="true"
				className="relative z-10 mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full surface"
				style={{ boxShadow: `inset 0 0 0 1.5px ${t.dot}`, color: t.dot }}
			>
				{t.icon}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<h4 className="text-sm font-semibold text-[color:var(--ink)]">{link.title}</h4>
					<span
						className={`inline-flex items-center gap-1 rounded-full ${t.badge} px-1.5 py-0.5 text-[10px] font-medium`}
					>
						{t.word}
					</span>
				</div>
				{link.plain ? (
					<p
						data-chrome
						className="mt-1 text-xs leading-relaxed text-[color:var(--muted)]"
					>
						{link.plain}
					</p>
				) : null}
				{showDetail ? (
					<div className="mt-2 rounded-lg surface-2 p-2.5">
						<p className="text-[11px] leading-relaxed text-[color:var(--muted)]">
							{link.detail}
						</p>
						{link.fields.length > 0 ? (
							<dl className="mt-2 space-y-1.5">
								{link.fields.map((f) => (
									<div key={f.label} className="flex flex-col gap-0.5">
										<dt
											data-chrome
											className="text-[10px] uppercase tracking-wide text-[color:var(--faint)]"
										>
											{f.label}
										</dt>
										<dd className="min-w-0">
											<Value value={f.value} mono={f.mono} />
										</dd>
									</div>
								))}
							</dl>
						) : null}
					</div>
				) : (
					<p className="mt-1 text-[11px] leading-relaxed text-[color:var(--faint)]">
						{link.detail}
					</p>
				)}
			</div>
		</li>
	);
}

const VERDICT_STYLE: Record<
	ProvenanceResult['verdict'],
	{ box: string; role: 'status' | 'alert' }
> = {
	verified: { box: 'alert-ok', role: 'status' },
	failed: { box: 'alert-error', role: 'alert' },
	partial: { box: 'alert-warn', role: 'status' },
	unsigned: { box: 'alert-info', role: 'status' },
	unavailable: { box: 'alert-warn', role: 'alert' },
};

export function ProvenanceChain({
	result,
	loading,
	children,
}: {
	result: ProvenanceResult | null;
	loading: boolean;
	/** The Merkle walk, rendered inside the chain right after the link it belongs to. */
	children?: ReactNode;
}): ReactElement {
	const [detail, setDetail] = useState(false);
	const detailId = useId();

	if (loading || !result) {
		return (
			<div className="space-y-3" aria-busy="true">
				<p className="text-sm text-[color:var(--muted)]">
					Checking the signature and re-computing the proof…
				</p>
				<div className="shimmer h-24 rounded-lg" aria-hidden="true" />
			</div>
		);
	}

	const style = VERDICT_STYLE[result.verdict];
	// Every link is rendered, including the ones this deployment does not offer. Hiding them would
	// leave the reader unable to tell "checked and fine" from "silently absent" — and the shape of
	// the whole chain, gaps included, is the honest picture.
	const links = result.links;

	return (
		<div className="space-y-4">
			<div
				className={`rounded-xl ${style.box} p-3.5`}
				role={style.role}
				aria-live={style.role === 'alert' ? 'assertive' : 'polite'}
			>
				<p className="text-sm font-semibold">{result.headline}</p>
				<p
					data-chrome
					className="mt-1 text-xs leading-relaxed"
					style={{ color: 'var(--muted)' }}
				>
					{result.summary}
				</p>
			</div>

			{result.verdict === 'unsigned' ? null : (
				<div className="flex items-center justify-between gap-2">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--faint)]">
						Chain of custody
					</h3>
					<button
						type="button"
						onClick={() => setDetail((d) => !d)}
						aria-expanded={detail}
						aria-controls={detailId}
						className="btn-ghost rounded-md px-2 py-1 text-[11px]"
					>
						{detail ? 'Hide cryptographic detail' : 'Show cryptographic detail'}
					</button>
				</div>
			)}

			<ol id={detailId} className="list-none">
				{links.map((link, i) => (
					<ChainLink
						key={link.id}
						link={link}
						last={i === links.length - 1 && !children}
						showDetail={detail}
					/>
				))}
			</ol>

			{children}
		</div>
	);
}
