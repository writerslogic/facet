// The bento box library. Each box lives in its own file and exports a `TileDef`; this list is the single
// place they're registered. Order here is the "Add tile" menu order. To add a box: create a file that
// exports a `TileDef`, then add it to `BOXES`.

import { channelsBox } from './ChannelsBox.js';
import { countriesBox } from './CountriesBox.js';
import { devicesBox } from './DevicesBox.js';
import { engagementBox } from './EngagementBox.js';
import { eventsBox } from './EventsBox.js';
import { eventsListBox } from './EventsListBox.js';
import { flowBox } from './FlowBox.js';
import { pagesBox } from './PagesBox.js';
import { pageviewsBox } from './PageviewsBox.js';
import { referrersBox } from './ReferrersBox.js';
import { trafficBox } from './TrafficBox.js';
import { visitorsBox } from './VisitorsBox.js';
import type { TileDef } from './types.js';

export const BOXES: TileDef[] = [
	trafficBox,
	pageviewsBox,
	visitorsBox,
	eventsBox,
	flowBox,
	pagesBox,
	referrersBox,
	countriesBox,
	devicesBox,
	channelsBox,
	eventsListBox,
	engagementBox,
];
