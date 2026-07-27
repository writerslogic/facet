// The bento box library. Each box lives in its own file and exports a `TileDef`; this list is the single
// place they're registered. Order here is the "Add tile" menu order. To add a box: create a file that
// exports a `TileDef`, then add it to `BOXES`.

import { attributionBox } from './AttributionBox.js';
import { browsersBox } from './BrowsersBox.js';
import { channelsBox } from './ChannelsBox.js';
import { connectionBox } from './ConnectionBox.js';
import { countriesBox } from './CountriesBox.js';
import { devicesBox } from './DevicesBox.js';
import { engagementBox } from './EngagementBox.js';
import { eventsBox } from './EventsBox.js';
import { eventsListBox } from './EventsListBox.js';
import { flowBox } from './FlowBox.js';
import { languagesBox } from './LanguagesBox.js';
import { networksBox } from './NetworksBox.js';
import { osBox } from './OsBox.js';
import { pagesBox } from './PagesBox.js';
import { pageviewsBox } from './PageviewsBox.js';
import { referrersBox } from './ReferrersBox.js';
import { regionsBox } from './RegionsBox.js';
import { revenueBox } from './RevenueBox.js';
import { screensBox } from './ScreensBox.js';
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
	browsersBox,
	osBox,
	screensBox,
	languagesBox,
	regionsBox,
	networksBox,
	connectionBox,
	revenueBox,
	attributionBox,
];
