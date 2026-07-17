// Traffic-channels breakdown: reuses TopList fed by the sessions-derived channel counts.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { TopList } from './TopList.js';

export function ChannelsPanel({
	channels,
}: {
	channels: CountRow[];
}): ReactElement {
	return <TopList title="Channels" rows={channels} />;
}
