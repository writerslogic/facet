// The CRM tab: contacts and companies, the one surface in this dashboard that holds directly
// identifying personal data.
//
// It is authenticated differently from every other tab, and that is deliberate rather than an
// oversight to fix. Everything else here reads with a per-site `clk_` API key; these routes refuse
// one, because a key that leaks costs you aggregate pageview counts while a key that could read
// contacts would cost you your customers' names, emails and phone numbers. So the CRM is gated on an
// operator session cookie plus a team role, and the panels below explain that rather than failing
// with a bare 401.
//
// Two states dominate what this tab renders in practice:
//   • NO CRM DATABASE (501). The extension is an optional second D1 binding that most deployments
//     never enable, so this is the DEFAULT and it renders as an explanation, never as an error.
//   • ROLE. `viewer` sees nothing here; `analyst` reads and writes; `admin` deletes and exports.
//     The destructive controls are hidden rather than offered and then refused — see
//     `canAdministerCrm` for what the browser can actually prove about the operator's role.

import { type ReactElement, useState } from 'react';
import { cn } from '../lib/cn.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { CompaniesPanel } from './crm/CompaniesPanel.js';
import { ContactsPanel } from './crm/ContactsPanel.js';

type Section = 'contacts' | 'companies';

const SECTIONS: { id: Section; label: string }[] = [
	{ id: 'contacts', label: 'Contacts' },
	{ id: 'companies', label: 'Companies' },
];

/** Roving-tabindex arrow navigation, as `role="tablist"` promises to assistive tech. Returns true
 * when the key was consumed, so the caller can suppress the page scroll. */
function onSectionKey(key: string, current: Section, select: (id: Section) => void): boolean {
	const index = SECTIONS.findIndex((s) => s.id === current);
	if (index < 0) return false;
	let next: number;
	if (key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
	else if (key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length;
	else if (key === 'Home') next = 0;
	else if (key === 'End') next = SECTIONS.length - 1;
	else return false;
	const target = SECTIONS[next];
	if (!target) return false;
	select(target.id);
	document.getElementById(`crm-tab-${target.id}`)?.focus();
	return true;
}

export function Crm({ siteId }: { siteId: string }): ReactElement {
	const [section, setSection] = useState<Section>('contacts');
	// Both selections live here so the two panels can hand off to each other: a contact's employer
	// opens the company, and a company's roster opens the person.
	const [contactId, setContactId] = useState('');
	const [companyId, setCompanyId] = useState('');

	const openCompany = (id: string): void => {
		setCompanyId(id);
		if (id) setSection('companies');
	};
	const openContact = (id: string): void => {
		setContactId(id);
		if (id) setSection('contacts');
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 pb-6">
			<div>
				<h2 className="font-semibold text-[color:var(--ink)] text-lg">CRM</h2>
				<p className="mt-0.5 max-w-prose text-[color:var(--muted)] text-sm">
					The people and organizations behind the numbers. A contact is only ever
					connected to analytics through an active signed consent record — never through
					anything stored on the contact itself — so a person with no consent simply has
					no link, and this tab says so rather than showing zeroes.
				</p>
			</div>

			{/* The chips above this tab are a filter over analytics dimensions. Nothing here honours
			    them, and a filtered label over unfiltered numbers is worse than no filter at all. */}
			<SegmentNotice tab="crm" />

			<div role="tablist" aria-label="CRM sections" className="flex flex-wrap gap-1">
				{SECTIONS.map((s) => (
					<button
						key={s.id}
						type="button"
						role="tab"
						id={`crm-tab-${s.id}`}
						aria-selected={section === s.id}
						aria-controls={`crm-panel-${s.id}`}
						tabIndex={section === s.id ? 0 : -1}
						onKeyDown={(e) => {
							if (onSectionKey(e.key, s.id, setSection)) e.preventDefault();
						}}
						onClick={() => setSection(s.id)}
						className={cn(
							'rounded-lg border px-3 py-1.5 font-medium text-xs transition',
							section === s.id
								? 'chip-active'
								: 'border-[color:rgb(var(--border))] text-[color:var(--muted)] hover:bg-[color:rgb(var(--hover))] hover:text-[color:var(--ink)]',
						)}
					>
						{s.label}
					</button>
				))}
			</div>

			<div
				role="tabpanel"
				id={`crm-panel-${section}`}
				aria-labelledby={`crm-tab-${section}`}
				className="min-w-0"
			>
				{section === 'contacts' ? (
					<ContactsPanel
						siteId={siteId}
						selectedId={contactId}
						onSelect={setContactId}
						onOpenCompany={openCompany}
					/>
				) : (
					<CompaniesPanel
						siteId={siteId}
						selectedId={companyId}
						onSelect={setCompanyId}
						onOpenContact={openContact}
					/>
				)}
			</div>
		</div>
	);
}
