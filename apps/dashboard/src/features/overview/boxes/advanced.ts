import { browsersBox } from '../../../components/boxes/BrowsersBox.js';
import { bubbleBox } from '../../../components/boxes/BubbleBox.js';
import { channelsBox } from '../../../components/boxes/ChannelsBox.js';
import { clockBox } from '../../../components/boxes/ClockBox.js';
import { connectionBox } from '../../../components/boxes/ConnectionBox.js';
import { devicesBox } from '../../../components/boxes/DevicesBox.js';
import { distributionBox } from '../../../components/boxes/DistributionBox.js';
import { engagementBox } from '../../../components/boxes/EngagementBox.js';
import { eventsListBox } from '../../../components/boxes/EventsListBox.js';
import { flowBox } from '../../../components/boxes/FlowBox.js';
import { languagesBox } from '../../../components/boxes/LanguagesBox.js';
import { networksBox } from '../../../components/boxes/NetworksBox.js';
import { osBox } from '../../../components/boxes/OsBox.js';
import { pathTreeBox } from '../../../components/boxes/PathTreeBox.js';
import { referrersBox } from '../../../components/boxes/ReferrersBox.js';
import { regionsBox } from '../../../components/boxes/RegionsBox.js';
import { screensBox } from '../../../components/boxes/ScreensBox.js';
import { trendsBox } from '../../../components/boxes/TrendsBox.js';
import type { TileDef } from '../../../components/boxes/types.js';

export const ADVANCED_TILES: Readonly<Record<string, TileDef>> = {
	flow: flowBox,
	trends: trendsBox,
	'path-tree': pathTreeBox,
	segments: bubbleBox,
	timing: clockBox,
	distribution: distributionBox,
	referrers: referrersBox,
	devices: devicesBox,
	channels: channelsBox,
	events_list: eventsListBox,
	engagement: engagementBox,
	browsers: browsersBox,
	os: osBox,
	screens: screensBox,
	languages: languagesBox,
	regions: regionsBox,
	networks: networksBox,
	connection: connectionBox,
};
