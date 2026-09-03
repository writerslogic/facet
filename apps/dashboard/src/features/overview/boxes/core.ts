// The six shipped tiles stay eager. Everything else is behind a dynamic group boundary.

import { countriesBox } from '../../../components/boxes/CountriesBox.js';
import { eventsBox } from '../../../components/boxes/EventsBox.js';
import { pagesBox } from '../../../components/boxes/PagesBox.js';
import { pageviewsBox } from '../../../components/boxes/PageviewsBox.js';
import { trafficBox } from '../../../components/boxes/TrafficBox.js';
import { visitorsBox } from '../../../components/boxes/VisitorsBox.js';
import type { TileDef } from '../../../components/boxes/types.js';

export const CORE_TILES: Readonly<Record<string, TileDef>> = {
	traffic: trafficBox,
	pageviews: pageviewsBox,
	visitors: visitorsBox,
	events: eventsBox,
	pages: pagesBox,
	countries: countriesBox,
};
