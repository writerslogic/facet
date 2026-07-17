// Interactions panel: system interaction events ($exposure/form_submit/etc), distinct from the
// marketer-defined Custom Events breakdown. Fed by /api/stats/interactions.

import type { ReactElement } from 'react';
import { useInteractions } from '../hooks/interactions.js';
import type { Range } from '../state.js';
import { Card, CardHeading } from './Card.js';
import { CardSkeletons, ErrorState } from './StatusStates.js';
import { TopList } from './TopList.js';

export function InteractionsPanel({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const { data, error, isLoading } = useInteractions(apiKey, siteId, range);
	const rows = data?.interactions ?? [];

	if (isLoading) {
		return (
			<Card>
				<CardHeading>Interactions</CardHeading>
				<CardSkeletons count={1} />
			</Card>
		);
	}
	if (error) {
		return (
			<ErrorState
				message="Could not load interactions"
				detail={error instanceof Error ? error.message : null}
			/>
		);
	}

	return <TopList title="Interactions" rows={rows} />;
}
