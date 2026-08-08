// The bento box library. Each box lives in its own file and exports a `TileDef`; this list is the single
// place they're registered. Order here is the "Add tile" menu order. To add a box: create a file that
// exports a `TileDef`, then add it to `BOXES`.

import { attributionBox } from './AttributionBox.js';
import { browsersBox } from './BrowsersBox.js';
import { bubbleBox } from './BubbleBox.js';
import { channelsBox } from './ChannelsBox.js';
import { clockBox } from './ClockBox.js';
import { connectionBox } from './ConnectionBox.js';
import { countriesBox } from './CountriesBox.js';
import { devicesBox } from './DevicesBox.js';
import { distributionBox } from './DistributionBox.js';
import { engagementBox } from './EngagementBox.js';
import { eventsBox } from './EventsBox.js';
import { eventsListBox } from './EventsListBox.js';
import { flowBox } from './FlowBox.js';
import { languagesBox } from './LanguagesBox.js';
import { networksBox } from './NetworksBox.js';
import { osBox } from './OsBox.js';
import { pagesBox } from './PagesBox.js';
import { pageviewsBox } from './PageviewsBox.js';
import { pathTreeBox } from './PathTreeBox.js';
import { pipelineBox } from './PipelineBox.js';
import { referrersBox } from './ReferrersBox.js';
import { regionsBox } from './RegionsBox.js';
import { revenueBox } from './RevenueBox.js';
import { screensBox } from './ScreensBox.js';
import { trafficBox } from './TrafficBox.js';
import { trendsBox } from './TrendsBox.js';
import { visitorsBox } from './VisitorsBox.js';
import type { TileDef } from './types.js';

export const BOXES: TileDef[] = [
	trafficBox,
	pageviewsBox,
	visitorsBox,
	eventsBox,
	flowBox,
	// Visualisation tiles, grouped with the other charts rather than among the ranked lists.
	trendsBox,
	pathTreeBox,
	bubbleBox,
	clockBox,
	distributionBox,
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
	pipelineBox,
];
