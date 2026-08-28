// Alert configuration: reusable signed destinations plus user-defined thresholds over the last
// completed UTC hour. The two resources stay visually separate because deleting a destination
// changes every alert, while deleting a rule changes only one condition.

import {
	ALERT_DESTINATION_TYPES,
	ALERT_SEVERITIES,
	type AlertDestinationType,
	type AlertSeverity,
	METRIC_ALERT_METRICS,
	METRIC_ALERT_OPERATORS,
	type MetricAlertMetric,
	type MetricAlertOperator,
} from '@facet/shared';
import { type FormEvent, type ReactElement, useState } from 'react';
import {
	useAlertDestinations,
	useCreateAlertDestination,
	useCreateMetricAlertRule,
	useDeleteAlertDestination,
	useDeleteMetricAlertRule,
	useMetricAlertRules,
} from '../../hooks/admin.js';
import { CardSkeletons, ErrorState } from '../StatusStates.js';
import {
	BlockedReason,
	ConfirmDelete,
	Field,
	FormControls,
	MutationStatus,
	Panel,
	Select,
} from './kit.js';

const METRIC_LABELS: Record<MetricAlertMetric, string> = {
	pageviews: 'Pageviews',
	visitors: 'Visitors',
	events: 'Custom events',
};

const OPERATOR_LABELS: Record<MetricAlertOperator, string> = {
	at_least: 'at least',
	at_most: 'at most',
};

function DestinationList({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	const destinations = useAlertDestinations(token, siteId);
	const create = useCreateAlertDestination(token, siteId);
	const remove = useDeleteAlertDestination(token, siteId);
	const [name, setName] = useState('');
	const [type, setType] = useState<AlertDestinationType>('webhook');
	const [target, setTarget] = useState('');
	const [minimum, setMinimum] = useState<AlertSeverity>('warning');
	const [secret, setSecret] = useState<string | null>(null);
	const canSubmit = Boolean(name.trim() && target.trim());
	const blocked = canSubmit
		? null
		: !name.trim() && !target.trim()
			? 'Enter a name and delivery target.'
			: !name.trim()
				? 'Enter a destination name.'
				: 'Enter the webhook URL or email address.';

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		setSecret(null);
		create.mutate(
			{
				site_id: siteId,
				name: name.trim(),
				type,
				target: target.trim(),
				min_severity: minimum,
			},
			{
				onSuccess: (data) => {
					setSecret(data.secret ?? null);
					setName('');
					setTarget('');
				},
			},
		);
	}

	return (
		<Panel
			title="Alert destinations"
			description="Signed webhooks work without extra bindings. Email additionally requires Cloudflare Email Routing and ALERT_EMAIL_FROM."
		>
			{secret ? (
				<div className="alert-warn mb-4 rounded-lg p-3 text-xs">
					<p className="font-semibold">Save this webhook signing secret now.</p>
					<p className="mt-1 text-[color:var(--muted)]">
						It is shown once and signs the exact alert body. Recreate the destination if
						it is lost.
					</p>
					<code
						data-selectable
						className="mt-2 block overflow-x-auto rounded bg-[color:rgb(var(--panel-strong))] p-2 font-mono text-[color:var(--ink)]"
					>
						{secret}
					</code>
				</div>
			) : null}
			<form onSubmit={onSubmit}>
				<FormControls busy={create.isPending} className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							id="alert-destination-name"
							label="Name"
							value={name}
							onChange={setName}
							placeholder="Operations"
						/>
						<Select
							id="alert-destination-type"
							label="Transport"
							value={type}
							onChange={(next) => setType(next as AlertDestinationType)}
						>
							{ALERT_DESTINATION_TYPES.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</Select>
					</div>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
						<Field
							id="alert-destination-target"
							label={type === 'webhook' ? 'HTTPS webhook URL' : 'Email address'}
							value={target}
							onChange={setTarget}
							placeholder={
								type === 'webhook'
									? 'https://hooks.example.com/facet'
									: 'oncall@example.com'
							}
							type={type === 'email' ? 'email' : 'url'}
							hint="Webhook URLs are re-checked against the SSRF policy at creation and delivery."
						/>
						<Select
							id="alert-destination-severity"
							label="Minimum severity"
							value={minimum}
							onChange={(next) => setMinimum(next as AlertSeverity)}
						>
							{ALERT_SEVERITIES.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</Select>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<BlockedReason reason={blocked} />
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							Add destination
						</button>
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Destination created.' : null}
				pendingLabel="Creating destination…"
			/>

			<div className="mt-5">
				{destinations.isLoading ? (
					<CardSkeletons count={1} />
				) : destinations.error ? (
					<ErrorState
						message="Could not load alert destinations"
						detail={
							destinations.error instanceof Error ? destinations.error.message : null
						}
					/>
				) : destinations.data && destinations.data.alert_destinations.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{destinations.data.alert_destinations.map((destination) => (
							<li
								key={destination.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{destination.name}
									</p>
									<p className="truncate text-[color:var(--muted)] text-xs">
										{destination.type} · {destination.target} ·{' '}
										{destination.min_severity}+
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => remove.mutate(destination.id)}
									consequence={`Delete "${destination.name}"? Every alert stops sending there.`}
									busy={remove.isPending}
								/>
							</li>
						))}
					</ul>
				) : (
					<p className="text-[color:var(--muted)] text-sm">
						No destinations yet. Rules can be saved, but they cannot notify anyone until
						a destination exists.
					</p>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting destination…"
			/>
		</Panel>
	);
}

function RuleList({ token, siteId }: { token: string; siteId: string }): ReactElement {
	const rules = useMetricAlertRules(token, siteId);
	const create = useCreateMetricAlertRule(token, siteId);
	const remove = useDeleteMetricAlertRule(token, siteId);
	const [name, setName] = useState('');
	const [metric, setMetric] = useState<MetricAlertMetric>('pageviews');
	const [operator, setOperator] = useState<MetricAlertOperator>('at_least');
	const [threshold, setThreshold] = useState('');
	const [severity, setSeverity] = useState<AlertSeverity>('warning');
	const thresholdNumber = Number(threshold);
	const validThreshold = /^\d+$/.test(threshold) && Number.isSafeInteger(thresholdNumber);
	const canSubmit = Boolean(name.trim() && validThreshold);
	const blocked = canSubmit
		? null
		: !name.trim() && !threshold
			? 'Enter a name and a non-negative whole-number threshold.'
			: !name.trim()
				? 'Enter a rule name.'
				: 'Threshold must be a non-negative whole number.';

	function onSubmit(event: FormEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		create.mutate(
			{
				site_id: siteId,
				name: name.trim(),
				metric,
				operator,
				threshold: thresholdNumber,
				severity,
			},
			{
				onSuccess: () => {
					setName('');
					setThreshold('');
				},
			},
		);
	}

	return (
		<Panel
			title="Metric alert rules"
			description="Checked hourly against exact counters from the last completed UTC hour. A matched rule sends once per hour to every enabled destination that accepts its severity."
		>
			<form onSubmit={onSubmit}>
				<FormControls busy={create.isPending} className="space-y-3">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							id="metric-alert-name"
							label="Rule name"
							value={name}
							onChange={setName}
							placeholder="Traffic disappeared"
						/>
						<Select
							id="metric-alert-metric"
							label="Metric"
							value={metric}
							onChange={(next) => setMetric(next as MetricAlertMetric)}
						>
							{METRIC_ALERT_METRICS.map((value) => (
								<option key={value} value={value}>
									{METRIC_LABELS[value]}
								</option>
							))}
						</Select>
					</div>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<Select
							id="metric-alert-operator"
							label="Condition"
							value={operator}
							onChange={(next) => setOperator(next as MetricAlertOperator)}
						>
							{METRIC_ALERT_OPERATORS.map((value) => (
								<option key={value} value={value}>
									{OPERATOR_LABELS[value]}
								</option>
							))}
						</Select>
						<Field
							id="metric-alert-threshold"
							label="Threshold"
							value={threshold}
							onChange={setThreshold}
							placeholder="0"
							type="number"
						/>
						<Select
							id="metric-alert-severity"
							label="Severity"
							value={severity}
							onChange={(next) => setSeverity(next as AlertSeverity)}
						>
							{ALERT_SEVERITIES.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</Select>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<BlockedReason reason={blocked} />
						<button
							type="submit"
							disabled={!canSubmit}
							className="btn-accent rounded-lg px-4 py-1.5 text-sm transition"
						>
							Add rule
						</button>
					</div>
				</FormControls>
			</form>
			<MutationStatus
				isPending={create.isPending}
				error={create.error}
				success={create.isSuccess ? 'Metric alert rule created.' : null}
				pendingLabel="Creating metric alert rule…"
			/>

			<div className="mt-5">
				{rules.isLoading ? (
					<CardSkeletons count={1} />
				) : rules.error ? (
					<ErrorState
						message="Could not load metric alert rules"
						detail={rules.error instanceof Error ? rules.error.message : null}
					/>
				) : rules.data && rules.data.metric_alert_rules.length > 0 ? (
					<ul className="divide-y divide-[color:rgb(var(--border))]">
						{rules.data.metric_alert_rules.map((rule) => (
							<li
								key={rule.id}
								className="flex items-center justify-between gap-3 py-2 text-sm"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-[color:var(--ink)]">
										{rule.name}
									</p>
									<p className="text-[color:var(--muted)] text-xs">
										{METRIC_LABELS[rule.metric]}{' '}
										{OPERATOR_LABELS[rule.operator]} {rule.threshold} per
										completed hour · {rule.severity}
									</p>
								</div>
								<ConfirmDelete
									onConfirm={() => remove.mutate(rule.id)}
									consequence={`Delete "${rule.name}"? It stops notifying on future hours.`}
									busy={remove.isPending}
								/>
							</li>
						))}
					</ul>
				) : (
					<p className="text-[color:var(--muted)] text-sm">
						No metric alert rules yet. Anomaly detection still uses the same
						destinations.
					</p>
				)}
			</div>
			<MutationStatus
				isPending={remove.isPending}
				error={remove.error}
				pendingLabel="Deleting metric alert rule…"
			/>
		</Panel>
	);
}

export function AlertsPanel({
	token,
	siteId,
}: {
	token: string;
	siteId: string;
}): ReactElement {
	return (
		<div className="space-y-4">
			<DestinationList token={token} siteId={siteId} />
			<RuleList token={token} siteId={siteId} />
		</div>
	);
}
