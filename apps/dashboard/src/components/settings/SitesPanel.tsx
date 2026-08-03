// Sites panel: create a site and list existing sites. Selecting a site scopes the key/goal/funnel/
// experiment/flag/identity panels below. Uses admin react-query hooks; the create form refreshes the
// list on success. Site ids stay selectable — they are the value the tracker snippet needs.

import type { Site } from '@facet/shared';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useCreateSite, useSites } from '../../hooks/admin.js';
import { cn } from '../../lib/cn.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { BlockedReason, Field, FormControls, MutationStatus, Panel } from './kit.js';

export function SitesPanel({
	token,
	onManageSite,
	activeSiteId,
}: {
	token: string;
	onManageSite: (siteId: string) => void;
	activeSiteId: string;
}): ReactElement {
	const sites = useSites(token);
	const create = useCreateSite(token);
	const [name, setName] = useState('');
	const [domain, setDomain] = useState('');

	const canSubmit = Boolean(name.trim() && domain.trim());
	// Named so the disabled submit explains itself instead of just sitting there dead.
	const blocked = canSubmit
		? null
		: !name.trim() && !domain.trim()
			? 'Enter a name and a domain to create a site.'
			: !name.trim()
				? 'Enter a name to create a site.'
				: 'Enter a domain to create a site.';

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		create.mutate(
			{ name: name.trim(), domain: domain.trim() },
			{
				onSuccess: (res) => {
					setName('');
					setDomain('');
					onManageSite(res.site.id);
				},
			},
		);
	}

	const count = sites.data?.sites.length ?? 0;

	return (
		<Panel
			title="Sites"
			description="Every site in this deployment. The admin token covers all of them; pick one to manage its keys and configuration."
			action={
				count > 0 ? (
					<span data-chrome className="badge-neutral rounded-full px-2 py-0.5 text-xs">
						{count} {count === 1 ? 'site' : 'sites'}
					</span>
				) : null
			}
		>
			<form onSubmit={onSubmit}>
				<FormControls
					busy={create.isPending}
					className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]"
				>
					<Field
						id="site-name"
						label="Name"
						value={name}
						onChange={setName}
						placeholder="My blog"
					/>
					<Field
						id="site-domain"
						label="Domain"
						value={domain}
						onChange={setDomain}
						placeholder="example.com"
					/>
					<div className="flex items-start pt-5">
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent w-full rounded-lg px-4 py-1.5 text-sm transition sm:w-auto"
						>
							Create site
						</button>
					</div>
				</FormControls>
			</form>
			<div className="mt-2">
				<BlockedReason reason={blocked} />
			</div>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Site created and selected below.' : null}
				pendingLabel="Creating site…"
			/>

			<div className="mt-5">
				{sites.isLoading ? (
					<CardSkeletons count={2} />
				) : sites.error ? (
					<ErrorState
						message="Could not load sites"
						detail={sites.error instanceof Error ? sites.error.message : null}
					/>
				) : sites.data && sites.data.sites.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{sites.data.sites.map((site) => (
							<SiteRow
								key={site.id}
								site={site}
								active={site.id === activeSiteId}
								onManage={() => onManageSite(site.id)}
							/>
						))}
					</ul>
				) : (
					<EmptyState title="No sites yet">Create your first site above.</EmptyState>
				)}
			</div>
		</Panel>
	);
}

function SiteRow({
	site,
	active,
	onManage,
}: {
	site: Site;
	active: boolean;
	onManage: () => void;
}): ReactElement {
	return (
		<li className="flex items-center justify-between gap-3 py-2 text-sm">
			<div className="min-w-0">
				<p className="truncate font-medium text-[color:var(--ink)]">{site.name}</p>
				<p className="truncate text-[color:var(--muted)] text-xs">
					{site.domain} ·{' '}
					<code data-selectable className="font-mono">
						{site.id}
					</code>
				</p>
			</div>
			<button
				type="button"
				onClick={onManage}
				aria-pressed={active}
				className={cn(
					'shrink-0 rounded-md border px-3 py-1 font-medium text-xs transition',
					active
						? 'chip-active'
						: 'border-[color:rgb(var(--border))] text-[color:var(--ink)] hover:bg-[color:rgb(var(--hover))]',
				)}
			>
				{active ? 'Managing' : 'Manage'}
			</button>
		</li>
	);
}
