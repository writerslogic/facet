// Traffic-channels breakdown: reuses TopList fed by the sessions-derived channel counts.

import type { CountRow } from '@countless/shared';
import type { ReactElement } from 'react';
import { TopList } from './TopList.js';

export function ChannelsPanel({
	channels,
}: {
	channels: CountRow[];
}): ReactElement {
	return <TopList title="Channels" rows={channels} />;
}
