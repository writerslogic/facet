// Sites panel: create a site and list existing sites. Selecting a site scopes the key/goal/funnel/
// experiment panels below. Uses admin react-query hooks; the create form refreshes the list on success.

import type { Site } from '@facet/shared';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useCreateSite, useSites } from '../../hooks/admin.js';
import { cn } from '../../lib/cn.js';
import { CardSkeletons, EmptyState, ErrorState } from '../StatusStates.js';
import { Field, MutationStatus, Panel } from './kit.js';

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

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!name.trim() || !domain.trim()) return;
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

	return (
		<Panel title="Sites">
			<form
				onSubmit={onSubmit}
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
				<div className="flex items-end">
					<button
						type="submit"
						disabled={create.isPending || !name.trim() || !domain.trim()}
						className="w-full rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 sm:w-auto"
					>
						Create site
					</button>
				</div>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Site created.' : null}
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
					<ul className="divide-y divide-neutral-100">
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
				<p className="truncate font-medium text-neutral-800">{site.name}</p>
				<p className="truncate text-xs text-neutral-400">
					{site.domain} · {site.id}
				</p>
			</div>
			<button
				type="button"
				onClick={onManage}
				aria-pressed={active}
				className={cn(
					'shrink-0 rounded-md border px-3 py-1 text-xs font-medium transition',
					active
						? 'border-sky-500 bg-sky-50 text-sky-700'
						: 'border-neutral-200 text-neutral-600 hover:bg-neutral-100',
				)}
			>
				{active ? 'Managing' : 'Manage'}
			</button>
		</li>
	);
}
